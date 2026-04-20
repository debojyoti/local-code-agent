/**
 * Integration tests for runTask().
 * runner.js and git/index.js are mocked so no real CLIs or git repo are needed.
 * State helpers and artifact writes use the real filesystem (temp directory).
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, unlink } from 'fs/promises';

// Static imports that do NOT transitively depend on the mocked modules
import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { TaskListSchema } from '../src/state/schemas.js';

// ─── Module mocks (must be declared before any import of executor) ────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

jest.unstable_mockModule('../src/git/index.js', () => ({
  createWorktree: jest.fn(),
  getChangedFiles: jest.fn(),
  getDiff: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const repoRoot = join(tmpdir(), `orch-runtask-test-${Date.now()}`);

const baseTask = {
  id: 'TASK-001',
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
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  dependencies: [],
};

async function resetTasks(): Promise<void> {
  const now = new Date().toISOString();
  await writeJson(orchestratorPaths.tasks(repoRoot), {
    version: '1',
    created_at: now,
    updated_at: now,
    tasks: [{ ...baseTask, status: 'pending', retry_count: 0, updated_at: now }],
  });
}

async function currentTaskStatus(): Promise<string | undefined> {
  const list = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
  return list?.tasks.find((t) => t.id === 'TASK-001')?.status;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runTask', () => {
  // Resolved after unstable_mockModule — must use dynamic import
  let runTask: (repoRoot: string, taskId: string) => Promise<import('../src/executor/index.js').RunTaskResult>;
  let mockRunCommand: jest.Mock;
  let mockCreateWorktree: jest.Mock;
  let mockGetChangedFiles: jest.Mock;
  let mockGetDiff: jest.Mock;

  const fakeWorktree = {
    taskId: 'TASK-001',
    worktreePath: '/fake/worktree/TASK-001',
    baseSha: 'deadbeef',
  };

  beforeAll(async () => {
    const executorMod = await import('../src/executor/index.js');
    runTask = executorMod.runTask;

    const runnerMod = await import('../src/core/runner.js');
    mockRunCommand = runnerMod.runCommand as jest.Mock;

    const gitMod = await import('../src/git/index.js');
    mockCreateWorktree = gitMod.createWorktree as jest.Mock;
    mockGetChangedFiles = gitMod.getChangedFiles as jest.Mock;
    mockGetDiff = gitMod.getDiff as jest.Mock;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await resetTasks();

    // Write a full config so all three mandatory checks have commands.
    await writeJson(orchestratorPaths.config(repoRoot), {
      version: '1',
      repo_path: repoRoot,
      lint_command: 'npm run lint',
      test_command: 'npm test',
      typecheck_command: 'npm run typecheck',
      max_retries: 3,
      dry_run: false,
      stop_on_blocked: true,
    });

    // Happy-path defaults: ok for all calls (claude + 3 checks).
    mockCreateWorktree.mockResolvedValue(fakeWorktree);
    mockGetChangedFiles.mockResolvedValue(['src/auth.ts']);
    mockGetDiff.mockResolvedValue('+export const auth = true;\n');
    mockRunCommand.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, ok: true });
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ─── Success path ─────────────────────────────────────────────────────────

  test('transitions task to reviewing on successful Claude execution', async () => {
    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.task.status).toBe('reviewing');
    expect(await currentTaskStatus()).toBe('reviewing');
  });

  test('execution result reflects Claude stdout and changed files', async () => {
    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.executionResult.stdout).toBe('ok');
    expect(result.executionResult.ok).toBe(true);
    expect(result.executionResult.changed_files).toContain('src/auth.ts');
    expect(result.executionResult.diff).toContain('+export const auth');
  });

  test('artifact paths are returned and non-empty', async () => {
    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.briefPath).toBeTruthy();
    expect(result.claudeOutputPath).toBeTruthy();
    expect(result.executionResultPath).toBeTruthy();
  });

  test('increments retry_count on each execution', async () => {
    const result = await runTask(repoRoot, 'TASK-001');
    expect(result.task.retry_count).toBe(1);
    expect(result.executionResult.attempt).toBe(1);
  });

  test('transitions task to failed when Claude exits non-zero', async () => {
    mockRunCommand.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1, ok: false });

    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.task.status).toBe('failed');
    expect(await currentTaskStatus()).toBe('failed');
  });

  // ─── Checks integration ──────────────────────────────────────────────────

  test('task fails with 3 failed check entries when config.json is missing', async () => {
    await unlink(orchestratorPaths.config(repoRoot));

    // Only the claude call fires; no check runCommand calls since config is absent.
    mockRunCommand.mockResolvedValueOnce({ stdout: 'done', stderr: '', exitCode: 0, ok: true });

    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.executionResult.checks).toHaveLength(3);
    expect(result.executionResult.checks.every((c) => !c.ok)).toBe(true);
    expect(result.executionResult.checks.every((c) => c.exit_code === -1)).toBe(true);
    expect(result.executionResult.ok).toBe(false);
    expect(result.task.status).toBe('failed');
  });

  test('task fails with a failed check entry when a command is blank in config', async () => {
    // typecheck_command is blank — should produce a failed entry, not a skip.
    await writeJson(orchestratorPaths.config(repoRoot), {
      version: '1',
      repo_path: repoRoot,
      lint_command: 'npm run lint',
      test_command: 'npm test',
      typecheck_command: '',
      max_retries: 3,
      dry_run: false,
      stop_on_blocked: true,
    });

    mockRunCommand
      .mockResolvedValueOnce({ stdout: 'done', stderr: '', exitCode: 0, ok: true })   // claude
      .mockResolvedValueOnce({ stdout: 'lint ok', stderr: '', exitCode: 0, ok: true }) // lint
      .mockResolvedValueOnce({ stdout: 'test ok', stderr: '', exitCode: 0, ok: true }); // test

    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.executionResult.checks).toHaveLength(3);
    expect(result.executionResult.checks[2]).toMatchObject({ name: 'typecheck', ok: false, exit_code: -1 });
    expect(result.executionResult.ok).toBe(false);
    expect(result.task.status).toBe('failed');
  });

  test('all three checks pass and task proceeds to reviewing', async () => {
    // beforeEach already writes a full config; just verify the happy path end-to-end.
    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.executionResult.checks).toHaveLength(3);
    expect(result.executionResult.checks.every((c) => c.ok)).toBe(true);
    expect(result.executionResult.ok).toBe(true);
    expect(result.task.status).toBe('reviewing');
  });

  test('task transitions to failed when a check exits non-zero', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: 'done', stderr: '', exitCode: 0, ok: true })     // claude
      .mockResolvedValueOnce({ stdout: '', stderr: 'lint errors', exitCode: 1, ok: false }) // lint fails
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '', exitCode: 0, ok: true })       // test
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '', exitCode: 0, ok: true });      // typecheck

    const result = await runTask(repoRoot, 'TASK-001');

    expect(result.executionResult.checks[0]).toMatchObject({ name: 'lint', ok: false });
    expect(result.executionResult.ok).toBe(false);
    expect(result.task.status).toBe('failed');
    expect(await currentTaskStatus()).toBe('failed');
  });

  // ─── Stuck-in-running guard ───────────────────────────────────────────────

  test('task is set to failed (not stuck in running) when an unexpected error occurs after marking running', async () => {
    // Claude returns OK, but then getChangedFiles throws unexpectedly
    mockGetChangedFiles.mockRejectedValue(new Error('git process crashed'));

    await expect(runTask(repoRoot, 'TASK-001')).rejects.toThrow('git process crashed');

    expect(await currentTaskStatus()).toBe('failed');
    expect(await currentTaskStatus()).not.toBe('running');
  });

  test('original error is rethrown after the stuck-in-running guard fires', async () => {
    mockGetDiff.mockRejectedValue(new Error('disk full'));

    await expect(runTask(repoRoot, 'TASK-001')).rejects.toThrow('disk full');
  });
});
