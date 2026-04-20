/**
 * Integration tests for repo-aware single-task execution.
 *
 * Covers:
 * - Task with `repo_id` creates its worktree against the resolved repo path.
 * - Single-repo (no manifest, no `repo_id`) still works and targets the root.
 * - Missing `repo_id` in workspace mode fails clearly.
 * - Unknown `repo_id` in workspace mode fails clearly.
 *
 * runCommand and git/index.js are mocked; filesystem state lives in a temp dir.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';

import { writeJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';

// ─── Module mocks (declared before any import of executor) ────────────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

jest.unstable_mockModule('../src/git/index.js', () => ({
  createWorktree: jest.fn(),
  getChangedFiles: jest.fn(),
  getDiff: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const tmp = join(tmpdir(), `orch-exec-ws-${Date.now()}`);

const now = () => new Date().toISOString();

function makeTask(overrides: Partial<{ id: string; repo_id: string }>) {
  const t = now();
  return {
    id: overrides.id ?? 'TASK-001',
    title: 'Add auth',
    goal: 'Implement JWT auth',
    status: 'pending' as const,
    priority: 1,
    allowed_files: ['src/auth.ts'],
    acceptance_criteria: ['tokens are validated'],
    implementation_notes: '',
    test_commands: ['npm test'],
    retry_count: 0,
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

  await writeJson(orchestratorPaths.config(root), {
    version: '1',
    repo_path: root,
    lint_command: 'npm run lint',
    test_command: 'npm test',
    typecheck_command: 'npm run typecheck',
    max_retries: 3,
    dry_run: false,
    stop_on_blocked: true,
  });

  if (manifest) {
    await writeJson(orchestratorPaths.repos(root), {
      version: '1',
      repos: manifest.repos.map((r) => ({ ...r, description: '' })),
    });
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runTask repo-awareness', () => {
  let runTask: typeof import('../src/executor/index.js').runTask;
  let mockRunCommand: jest.Mock;
  let mockCreateWorktree: jest.Mock;
  let mockGetChangedFiles: jest.Mock;
  let mockGetDiff: jest.Mock;

  beforeAll(async () => {
    ({ runTask } = await import('../src/executor/index.js'));

    const runnerMod = await import('../src/core/runner.js');
    mockRunCommand = runnerMod.runCommand as jest.Mock;

    const gitMod = await import('../src/git/index.js');
    mockCreateWorktree = gitMod.createWorktree as jest.Mock;
    mockGetChangedFiles = gitMod.getChangedFiles as jest.Mock;
    mockGetDiff = gitMod.getDiff as jest.Mock;

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Happy-path defaults; individual tests can override.
    mockGetChangedFiles.mockResolvedValue([]);
    mockGetDiff.mockResolvedValue('');
    mockRunCommand.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, ok: true });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  // ─── Workspace mode: repo_id resolution ───────────────────────────────────

  test('task with repo_id creates the worktree against the resolved repo path', async () => {
    const root = join(tmp, 'ws-resolves');
    const repoAPath = join(root, 'repoA');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'repoA' }),
      { repos: [{ id: 'repoA', path: repoAPath }] },
    );

    mockCreateWorktree.mockResolvedValue({
      taskId: 'TASK-001',
      worktreePath: '/fake/wt/TASK-001',
      baseSha: 'abc',
    });

    await runTask(root, 'TASK-001');

    // createWorktree(workspaceRoot, taskId, gitRepoPath)
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    const [wsArg, idArg, repoPathArg] = mockCreateWorktree.mock.calls[0];
    expect(wsArg).toBe(root);
    expect(idArg).toBe('TASK-001');
    expect(repoPathArg).toBe(repoAPath);
  });

  test('task with repo_id using a relative path is resolved against the workspace root', async () => {
    const root = join(tmp, 'ws-relpath');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'svc' }),
      { repos: [{ id: 'svc', path: './services/svc' }] },
    );

    mockCreateWorktree.mockResolvedValue({
      taskId: 'TASK-001',
      worktreePath: '/fake/wt/TASK-001',
      baseSha: 'abc',
    });

    await runTask(root, 'TASK-001');

    const [, , repoPathArg] = mockCreateWorktree.mock.calls[0];
    expect(repoPathArg).toBe(join(root, 'services/svc'));
  });

  // ─── Single-repo mode ─────────────────────────────────────────────────────

  test('single-repo task (no manifest, no repo_id) targets the workspace root', async () => {
    const root = join(tmp, 'single-repo');
    await seedState(root, makeTask({ id: 'TASK-001' }));

    mockCreateWorktree.mockResolvedValue({
      taskId: 'TASK-001',
      worktreePath: '/fake/wt/TASK-001',
      baseSha: 'abc',
    });

    await runTask(root, 'TASK-001');

    const [wsArg, , repoPathArg] = mockCreateWorktree.mock.calls[0];
    expect(wsArg).toBe(root);
    // In single-repo mode the target repo equals the state root.
    expect(repoPathArg).toBe(root);
  });

  // ─── Failure modes ────────────────────────────────────────────────────────

  test('workspace mode + task missing repo_id fails clearly before creating a worktree', async () => {
    const root = join(tmp, 'ws-missing-id');
    await seedState(
      root,
      makeTask({ id: 'TASK-001' }), // no repo_id
      { repos: [{ id: 'repoA', path: join(root, 'repoA') }] },
    );

    await expect(runTask(root, 'TASK-001')).rejects.toThrow(/repo_id/);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  test('workspace mode + unknown repo_id fails clearly before creating a worktree', async () => {
    const root = join(tmp, 'ws-unknown-id');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'ghost' }),
      { repos: [{ id: 'repoA', path: join(root, 'repoA') }] },
    );

    await expect(runTask(root, 'TASK-001')).rejects.toThrow(/ghost/);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  test('workspace mode falls back to task test_commands when config.json is missing', async () => {
    const root = join(tmp, 'ws-no-config');
    const repoAPath = join(root, 'repoA');
    await seedState(
      root,
      makeTask({ id: 'TASK-001', repo_id: 'repoA' }),
      { repos: [{ id: 'repoA', path: repoAPath }] },
    );

    // Remove config written by seedState to exercise workspace fallback behavior.
    const { rm: rmFile } = await import('fs/promises');
    await rmFile(orchestratorPaths.config(root), { force: true });

    mockCreateWorktree.mockResolvedValue({
      taskId: 'TASK-001',
      worktreePath: '/fake/wt/TASK-001',
      baseSha: 'abc',
    });

    await runTask(root, 'TASK-001');

    // claude + fallback test command
    expect(mockRunCommand).toHaveBeenCalledTimes(2);
    expect(mockRunCommand.mock.calls[1][0]).toBe('sh');
    expect(mockRunCommand.mock.calls[1][1]).toEqual(['-c', 'npm test']);
    expect(mockRunCommand.mock.calls[1][2]?.cwd).toBe('/fake/wt/TASK-001');
  });
});
