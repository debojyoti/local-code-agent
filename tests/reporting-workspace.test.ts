/**
 * Tests for workspace-aware audit/report behavior.
 *
 * Covers:
 * - Audit prompt in workspace mode lists declared repos and includes a Repo column.
 * - Report markdown includes a Repositories summary block and per-task repo tags.
 * - FinalReport JSON carries `repo_id` on task_summaries for workspace tasks.
 * - Single-repo behavior is unchanged (no Repo column, no Repositories block).
 *
 * runCommand is mocked; filesystem uses a real temp dir.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readFile, mkdir, writeFile } from 'fs/promises';

import { writeJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import type { Task } from '../src/state/schemas.js';

// ─── Module mock ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const tmp = join(tmpdir(), `orch-reporting-ws-${Date.now()}`);
const NOW = new Date().toISOString();

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    status: 'passed',
    priority: 1,
    allowed_files: [],
    acceptance_criteria: [],
    implementation_notes: '',
    test_commands: [],
    retry_count: 0,
    max_retries: 3,
    created_at: NOW,
    updated_at: NOW,
    dependencies: [],
    ...overrides,
  };
}

async function seedWorkspace(
  root: string,
  tasks: Task[],
  repos: Array<{ id: string; path: string }>,
): Promise<void> {
  await mkdir(orchestratorPaths.root(root), { recursive: true });
  await writeJson(orchestratorPaths.tasks(root), {
    version: '1', created_at: NOW, updated_at: NOW, tasks,
  });
  await writeJson(orchestratorPaths.repos(root), {
    version: '1',
    repos: repos.map((r) => ({ ...r, description: '' })),
  });
}

async function seedSingleRepo(root: string, tasks: Task[]): Promise<void> {
  await mkdir(orchestratorPaths.root(root), { recursive: true });
  await writeJson(orchestratorPaths.tasks(root), {
    version: '1', created_at: NOW, updated_at: NOW, tasks,
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('reporting workspace mode', () => {
  let generateReport: typeof import('../src/reporting/index.js').generateReport;
  let runAudit: typeof import('../src/reporting/index.js').runAudit;
  let buildAuditPrompt: typeof import('../src/reporting/index.js').buildAuditPrompt;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    const mod = await import('../src/reporting/index.js');
    generateReport = mod.generateReport;
    runAudit = mod.runAudit;
    buildAuditPrompt = mod.buildAuditPrompt;

    const runner = await import('../src/core/runner.js');
    mockRunCommand = runner.runCommand as jest.Mock;

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  // ─── Audit prompt ─────────────────────────────────────────────────────────

  test('audit prompt in workspace mode lists declared repos and marks each task with Repo', async () => {
    const root = join(tmp, 'audit-ws');
    await seedWorkspace(
      root,
      [
        makeTask('A', { repo_id: 'repoA', status: 'passed' }),
        makeTask('B', { repo_id: 'repoB', status: 'failed' }),
      ],
      [
        { id: 'repoA', path: join(root, 'repoA') },
        { id: 'repoB', path: join(root, 'repoB') },
      ],
    );

    mockRunCommand.mockResolvedValue({
      stdout: '```json\n{"overall":"PARTIAL","summary":"mixed","concerns":[]}\n```',
      stderr: '', exitCode: 0, ok: true,
    });

    const result = await runAudit(root);

    const prompt = await readFile(result.promptPath, 'utf8');
    // Multi-repo language
    expect(prompt).toContain('multi-repo workspace');
    // Declared repositories section lists both
    expect(prompt).toContain('## Workspace');
    expect(prompt).toContain('**repoA**');
    expect(prompt).toContain('**repoB**');
    // Task table has a Repo column
    expect(prompt).toMatch(/\|\s*ID\s*\|\s*Repo\s*\|\s*Title\s*\|/);
    // Both task rows carry their repo id in the table
    expect(prompt).toMatch(/\|\s*A\s*\|\s*repoA\s*\|/);
    expect(prompt).toMatch(/\|\s*B\s*\|\s*repoB\s*\|/);
  });

  test('audit prompt in single-repo mode omits the Repo column and Workspace section', () => {
    const prompt = buildAuditPrompt('/some/repo', [
      { task: makeTask('A', { status: 'passed' }), latestReview: null },
    ]);

    expect(prompt).not.toContain('## Workspace');
    expect(prompt).toContain('## Repository');
    expect(prompt).not.toMatch(/\|\s*ID\s*\|\s*Repo\s*\|/);
  });

  // ─── Report markdown ──────────────────────────────────────────────────────

  test('workspace report includes Repositories summary with per-repo counts', async () => {
    const root = join(tmp, 'report-ws-repos');
    await seedWorkspace(
      root,
      [
        makeTask('A', { repo_id: 'frontend', status: 'passed' }),
        makeTask('B', { repo_id: 'frontend', status: 'failed' }),
        makeTask('C', { repo_id: 'backend', status: 'passed' }),
      ],
      [
        { id: 'frontend', path: join(root, 'frontend') },
        { id: 'backend',  path: join(root, 'backend') },
      ],
    );

    const result = await generateReport(root);
    const md = await readFile(result.reportPath, 'utf8');

    expect(md).toContain('## Repositories');
    // frontend: 2 tasks (1 passed, 1 failed)
    expect(md).toMatch(/\|\s*frontend\s*\|[^|]*\|\s*2\s*\|\s*1\s*\|\s*1\s*\|\s*0\s*\|/);
    // backend: 1 task (1 passed)
    expect(md).toMatch(/\|\s*backend\s*\|[^|]*\|\s*1\s*\|\s*1\s*\|\s*0\s*\|\s*0\s*\|/);
    // Workspace root label, not "Repository"
    expect(md).toContain('**Workspace root:**');
  });

  test('workspace report per-task sections include the repo_id tag', async () => {
    const root = join(tmp, 'report-ws-task-section');
    await seedWorkspace(
      root,
      [makeTask('A', { repo_id: 'svc', status: 'passed' })],
      [{ id: 'svc', path: join(root, 'svc') }],
    );

    const result = await generateReport(root);
    const md = await readFile(result.reportPath, 'utf8');

    // Per-task heading carries the repo tag
    expect(md).toMatch(/###\s+A\s+\[svc\]:\s+Task A/);
    // Repo bullet inside the task section
    expect(md).toMatch(/-\s+\*\*Repo:\*\*\s+svc/);
  });

  test('workspace final-report.json carries repo_id on each task_summary', async () => {
    const root = join(tmp, 'report-ws-json');
    await seedWorkspace(
      root,
      [
        makeTask('A', { repo_id: 'repoA', status: 'passed' }),
        makeTask('B', { repo_id: 'repoB', status: 'failed' }),
      ],
      [
        { id: 'repoA', path: join(root, 'repoA') },
        { id: 'repoB', path: join(root, 'repoB') },
      ],
    );

    const result = await generateReport(root);

    const summaries = result.finalReport.task_summaries;
    expect(summaries.find((s) => s.id === 'A')?.repo_id).toBe('repoA');
    expect(summaries.find((s) => s.id === 'B')?.repo_id).toBe('repoB');

    // And it round-trips through disk.
    const raw = await readFile(result.reportJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const byId = new Map<string, { repo_id?: string }>(
      parsed.task_summaries.map((s: { id: string; repo_id?: string }) => [s.id, s]),
    );
    expect(byId.get('A')?.repo_id).toBe('repoA');
    expect(byId.get('B')?.repo_id).toBe('repoB');
  });

  // ─── Single-repo backwards compatibility ──────────────────────────────────

  test('single-repo report omits Repositories block and repo_id fields', async () => {
    const root = join(tmp, 'report-single');
    await seedSingleRepo(root, [makeTask('A', { status: 'passed' })]);

    const result = await generateReport(root);
    const md = await readFile(result.reportPath, 'utf8');

    expect(md).not.toContain('## Repositories');
    expect(md).toContain('**Repository:**');
    // Task section heading has no [repo] tag.
    expect(md).toMatch(/###\s+A:\s+Task A/);
    expect(md).not.toMatch(/-\s+\*\*Repo:\*\*/);

    // And task_summaries carries no repo_id.
    expect(result.finalReport.task_summaries[0].repo_id).toBeUndefined();
  });

  // ─── Malformed manifest: fail loudly instead of silent fallback ───────────

  test('report fails clearly when repos.json is invalid JSON (not silent single-repo fallback)', async () => {
    const root = join(tmp, 'report-bad-json');
    await seedSingleRepo(root, [makeTask('A', { status: 'passed' })]);
    // Write a malformed repos.json — this must not be swallowed.
    await writeFile(orchestratorPaths.repos(root), '{ not valid json', 'utf8');

    await expect(generateReport(root)).rejects.toThrow();
  });

  test('report fails clearly when repos.json does not match the schema', async () => {
    const root = join(tmp, 'report-bad-schema');
    await seedSingleRepo(root, [makeTask('A', { status: 'passed' })]);
    // Parseable JSON, wrong shape (missing `repos` array).
    await writeJson(orchestratorPaths.repos(root), { version: '1' });

    await expect(generateReport(root)).rejects.toThrow();
  });

  test('audit fails clearly when repos.json is invalid', async () => {
    const root = join(tmp, 'audit-bad-json');
    await seedSingleRepo(root, [makeTask('A', { status: 'passed' })]);
    await writeFile(orchestratorPaths.repos(root), 'not-json', 'utf8');

    // runCommand would return the Codex mock default — but we should fail
    // during prompt construction, before Codex is invoked.
    mockRunCommand.mockResolvedValue({
      stdout: '```json\n{"overall":"PASS","summary":"x","concerns":[]}\n```',
      stderr: '', exitCode: 0, ok: true,
    });

    await expect(runAudit(root)).rejects.toThrow();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});
