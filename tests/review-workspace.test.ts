/**
 * Integration tests for repo-aware review.
 *
 * Covers:
 * - Task with `repo_id` in workspace mode: Codex is invoked with cwd set to the
 *   resolved target repo path.
 * - Single-repo mode (no manifest, no `repo_id`): Codex is invoked with cwd set
 *   to the state root.
 * - Missing `repo_id` in workspace mode: fails clearly before invoking Codex.
 * - Unknown `repo_id` in workspace mode: fails clearly before invoking Codex.
 *
 * runCommand is mocked; state and artifacts live in a temp directory.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';

import { writeJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';

// ─── Module mock (declared before any import of review) ──────────────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const tmp = join(tmpdir(), `orch-review-ws-${Date.now()}`);

const now = () => new Date().toISOString();

const passReviewOutput = JSON.stringify({
  verdict: 'PASS',
  summary: 'OK',
  acceptance_checklist: [],
  issues_found: [],
  fix_brief: '',
  confidence: 0.9,
});

function makeTask(overrides: Partial<{ id: string; repo_id: string }>) {
  const t = now();
  return {
    id: overrides.id ?? 'TASK-001',
    title: 'Add thing',
    goal: 'Do the thing',
    status: 'reviewing' as const,
    priority: 1,
    allowed_files: ['src/thing.ts'],
    acceptance_criteria: ['thing works'],
    implementation_notes: '',
    test_commands: ['npm test'],
    retry_count: 1,
    max_retries: 3,
    created_at: t,
    updated_at: t,
    dependencies: [],
    ...(overrides.repo_id !== undefined ? { repo_id: overrides.repo_id } : {}),
  };
}

async function seedState(
  root: string,
  task: ReturnType<typeof makeTask>,
  manifest?: { repos: Array<{ id: string; path: string }> },
): Promise<void> {
  await mkdir(orchestratorPaths.root(root), { recursive: true });

  await writeJson(orchestratorPaths.tasks(root), {
    version: '1',
    created_at: now(),
    updated_at: now(),
    tasks: [task],
  });

  // An execution result must exist so findLatestExecutionResult succeeds.
  const artifactDir = join(orchestratorPaths.artifacts(root), task.id);
  await writeJson(join(artifactDir, 'execution-result-attempt-1.json'), {
    task_id: task.id,
    attempt: 1,
    stdout: 'done',
    stderr: '',
    exit_code: 0,
    ok: true,
    changed_files: ['src/thing.ts'],
    diff: '+export const x = 1;\n',
    checks: [],
    started_at: now(),
    completed_at: now(),
  });

  if (manifest) {
    await writeJson(orchestratorPaths.repos(root), {
      version: '1',
      repos: manifest.repos.map((r) => ({ ...r, description: '' })),
    });
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runReview repo-awareness', () => {
  let runReview: typeof import('../src/review/index.js').runReview;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    ({ runReview } = await import('../src/review/index.js'));

    const runnerMod = await import('../src/core/runner.js');
    mockRunCommand = runnerMod.runCommand as jest.Mock;

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunCommand.mockResolvedValue({
      stdout: '```json\n' + passReviewOutput + '\n```',
      stderr: '',
      exitCode: 0,
      ok: true,
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  // ─── Workspace mode: repo_id resolution ───────────────────────────────────

  test('task with repo_id invokes Codex with cwd set to the resolved target repo', async () => {
    const root = join(tmp, 'ws-resolves');
    const repoAPath = join(root, 'repoA');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'repoA' }),
      { repos: [{ id: 'repoA', path: repoAPath }] },
    );

    await runReview(root, 'TASK-001');

    // The only runCommand call in runReview is the Codex invocation.
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockRunCommand.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('--quiet');
    expect(opts?.cwd).toBe(repoAPath);
  });

  test('task with repo_id using a relative path resolves against the workspace root', async () => {
    const root = join(tmp, 'ws-relpath');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'svc' }),
      { repos: [{ id: 'svc', path: './services/svc' }] },
    );

    await runReview(root, 'TASK-001');

    const [, , opts] = mockRunCommand.mock.calls[0];
    expect(opts?.cwd).toBe(join(root, 'services/svc'));
  });

  // ─── Single-repo mode ─────────────────────────────────────────────────────

  test('single-repo task (no manifest, no repo_id) runs Codex with cwd set to the state root', async () => {
    const root = join(tmp, 'single-repo');
    await seedState(root, makeTask({ id: 'TASK-001' }));

    await runReview(root, 'TASK-001');

    const [, , opts] = mockRunCommand.mock.calls[0];
    expect(opts?.cwd).toBe(root);
  });

  // ─── Failure modes ────────────────────────────────────────────────────────

  test('workspace mode + task missing repo_id fails clearly without invoking Codex', async () => {
    const root = join(tmp, 'ws-missing-id');
    await seedState(
      root,
      makeTask({ id: 'TASK-001' }), // no repo_id
      { repos: [{ id: 'repoA', path: join(root, 'repoA') }] },
    );

    await expect(runReview(root, 'TASK-001')).rejects.toThrow(/repo_id/);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  test('workspace mode + unknown repo_id fails clearly without invoking Codex', async () => {
    const root = join(tmp, 'ws-unknown-id');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'ghost' }),
      { repos: [{ id: 'repoA', path: join(root, 'repoA') }] },
    );

    await expect(runReview(root, 'TASK-001')).rejects.toThrow(/ghost/);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});
