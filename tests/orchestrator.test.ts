/**
 * Tests for runOrchestration().
 * runTaskLoop is mocked; state helpers and filesystem use a real temp dir.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, unlink } from 'fs/promises';

import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { TaskListSchema, StateSchema } from '../src/state/schemas.js';
import type { Task } from '../src/state/schemas.js';
import type { LoopResult } from '../src/executor/loop.js';

// ─── Module mock ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/executor/loop.js', () => ({
  runTaskLoop: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const repoRoot = join(tmpdir(), `orch-test-${Date.now()}`);

const NOW = new Date().toISOString();

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    status: 'pending',
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

function makePassResult(task: Task): LoopResult {
  return {
    task: { ...task, status: 'passed', updated_at: NOW },
    attempts: [{ attemptNum: 1, executionOk: true, verdict: 'PASS' }],
    stoppedReason: 'pass',
  };
}

function makeBlockedResult(task: Task): LoopResult {
  return {
    task: { ...task, status: 'blocked', updated_at: NOW },
    attempts: [{ attemptNum: 1, executionOk: true, verdict: 'BLOCKED' }],
    stoppedReason: 'blocked',
  };
}

function makeFailedResult(task: Task): LoopResult {
  return {
    task: { ...task, status: 'failed', updated_at: NOW },
    attempts: [{ attemptNum: 1, executionOk: false, verdict: null }],
    stoppedReason: 'failed',
  };
}

async function seedTasks(tasks: Task[]) {
  await writeJson(orchestratorPaths.tasks(repoRoot), {
    version: '1',
    created_at: NOW,
    updated_at: NOW,
    tasks,
  });
}

async function seedState(status: string, currentTaskId: string | null = null) {
  await writeJson(orchestratorPaths.state(repoRoot), {
    version: '1',
    status,
    current_task_id: currentTaskId,
    started_at: NOW,
    updated_at: NOW,
  });
}

async function readTasks() {
  const list = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
  return list?.tasks ?? [];
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runOrchestration', () => {
  let runOrchestration: (repoRoot: string, resume: boolean) => Promise<import('../src/core/orchestrator.js').OrchestrationResult>;
  let mockRunTaskLoop: jest.Mock;

  beforeAll(async () => {
    const orchMod = await import('../src/core/orchestrator.js');
    runOrchestration = orchMod.runOrchestration;

    const loopMod = await import('../src/executor/loop.js');
    mockRunTaskLoop = loopMod.runTaskLoop as jest.Mock;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Remove config.json so each test starts with defaults (stop_on_blocked=true etc.)
    await unlink(orchestratorPaths.config(repoRoot)).catch(() => {/* not present */});
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ─── Dependency ordering ──────────────────────────────────────────────────

  test('runs tasks in dependency order (A → B → C)', async () => {
    const taskA = makeTask('A');
    const taskB = makeTask('B', { dependencies: ['A'] });
    const taskC = makeTask('C', { dependencies: ['B'] });
    // Seed in reverse order to confirm sorting, not insertion order, is used
    await seedTasks([taskC, taskB, taskA]);

    mockRunTaskLoop
      .mockResolvedValueOnce(makePassResult(taskA))
      .mockResolvedValueOnce(makePassResult(taskB))
      .mockResolvedValueOnce(makePassResult(taskC));

    const result = await runOrchestration(repoRoot, false);

    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.blocked).toBe(0);

    // Verify call order: A must come before B, B before C
    const callOrder = mockRunTaskLoop.mock.calls.map((c) => c[1] as string);
    expect(callOrder).toEqual(['A', 'B', 'C']);
  });

  test('skips tasks whose dependency did not pass', async () => {
    const taskA = makeTask('A');
    const taskB = makeTask('B', { dependencies: ['A'] });
    await seedTasks([taskA, taskB]);
    // Use stop_on_blocked=false so the loop reaches B and evaluates it
    await writeJson(orchestratorPaths.config(repoRoot), {
      version: '1',
      repo_path: repoRoot,
      stop_on_blocked: false,
      max_retries: 3,
      lint_command: '',
      test_command: '',
      typecheck_command: '',
      dry_run: false,
    });

    // A is blocked → B should be skipped (unmet dep), not run
    mockRunTaskLoop.mockResolvedValueOnce(makeBlockedResult(taskA));

    const result = await runOrchestration(repoRoot, false);

    expect(result.blocked).toBe(1);
    expect(result.skipped).toBe(1);
    // B should never be attempted
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(1);
    expect(mockRunTaskLoop.mock.calls[0][1]).toBe('A');
  });

  // ─── Missing dependency failure ───────────────────────────────────────────

  test('throws a clear error when a task references a non-existent dependency ID', async () => {
    const taskA = makeTask('A', { dependencies: ['GHOST-99'] });
    await seedTasks([taskA]);

    await expect(runOrchestration(repoRoot, false)).rejects.toThrow(
      'Task A references unknown dependency ID(s): GHOST-99',
    );

    expect(mockRunTaskLoop).not.toHaveBeenCalled();
  });

  test('includes all missing IDs in the error when multiple are absent', async () => {
    const taskA = makeTask('A', { dependencies: ['X', 'Y'] });
    await seedTasks([taskA]);

    await expect(runOrchestration(repoRoot, false)).rejects.toThrow(/X.*Y|Y.*X/);
  });

  // ─── Resume: stuck tasks reset ────────────────────────────────────────────

  test('resets tasks in "running" status to "pending" before resuming', async () => {
    const stuckTask = makeTask('T1', { status: 'running' });
    await seedTasks([stuckTask]);
    await seedState('paused', 'T1');

    mockRunTaskLoop.mockResolvedValueOnce(makePassResult(stuckTask));

    await runOrchestration(repoRoot, true);

    // runTaskLoop should have been called (task was reset and re-queued)
    expect(mockRunTaskLoop).toHaveBeenCalledWith(expect.any(String), 'T1');
  });

  test('resets tasks in "reviewing" status to "pending" before resuming', async () => {
    const stuckTask = makeTask('T1', { status: 'reviewing' });
    await seedTasks([stuckTask]);
    await seedState('paused', 'T1');

    mockRunTaskLoop.mockResolvedValueOnce(makePassResult(stuckTask));

    await runOrchestration(repoRoot, true);

    // runTaskLoop was called, confirming the task was reset to pending and re-queued
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(1);
    expect(mockRunTaskLoop.mock.calls[0][1]).toBe('T1');

    // tasks.json still shows 'pending' because the real updateTask inside runTaskLoop
    // is not called (runTaskLoop is mocked). The key thing is the reset happened.
    const tasks = await readTasks();
    expect(tasks.find((t) => t.id === 'T1')?.status).toBe('pending');
  });

  test('does not reset tasks in terminal statuses on resume', async () => {
    const passedTask = makeTask('T1', { status: 'passed' });
    const failedTask = makeTask('T2', { status: 'failed' });
    await seedTasks([passedTask, failedTask]);
    await seedState('paused');

    await runOrchestration(repoRoot, true);

    // Neither passed nor failed tasks should be re-run
    expect(mockRunTaskLoop).not.toHaveBeenCalled();

    const tasks = await readTasks();
    expect(tasks.find((t) => t.id === 'T1')?.status).toBe('passed');
    expect(tasks.find((t) => t.id === 'T2')?.status).toBe('failed');
  });

  test('resume throws if state.json is missing', async () => {
    const taskA = makeTask('A');
    await seedTasks([taskA]);
    // Remove state.json if left by a prior test
    await unlink(orchestratorPaths.state(repoRoot)).catch(() => {/* already absent */});

    await expect(runOrchestration(repoRoot, true)).rejects.toThrow(
      /state\.json not found/,
    );

    expect(mockRunTaskLoop).not.toHaveBeenCalled();
  });

  // ─── Stop on blocked ──────────────────────────────────────────────────────

  test('stops after the first blocked task when stop_on_blocked is true (default)', async () => {
    const taskA = makeTask('A');
    const taskB = makeTask('B');
    await seedTasks([taskA, taskB]);
    // No config.json → stop_on_blocked defaults to true

    mockRunTaskLoop.mockResolvedValueOnce(makeBlockedResult(taskA));

    const result = await runOrchestration(repoRoot, false);

    expect(result.blocked).toBe(1);
    expect(result.failed).toBe(0);
    // B is never reached
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(1);
  });

  test('continues past a blocked task when stop_on_blocked is false', async () => {
    const taskA = makeTask('A');
    const taskB = makeTask('B');
    await seedTasks([taskA, taskB]);
    await writeJson(orchestratorPaths.config(repoRoot), {
      version: '1',
      repo_path: repoRoot,
      stop_on_blocked: false,
      max_retries: 3,
      lint_command: '',
      test_command: '',
      typecheck_command: '',
      dry_run: false,
    });

    mockRunTaskLoop
      .mockResolvedValueOnce(makeBlockedResult(taskA))
      .mockResolvedValueOnce(makePassResult(taskB));

    const result = await runOrchestration(repoRoot, false);

    expect(result.blocked).toBe(1);
    expect(result.passed).toBe(1);
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(2);
  });

  // ─── Stop on failed ───────────────────────────────────────────────────────

  test('stops after a failed task and does not run subsequent tasks', async () => {
    const taskA = makeTask('A');
    const taskB = makeTask('B');
    await seedTasks([taskA, taskB]);

    mockRunTaskLoop.mockResolvedValueOnce(makeFailedResult(taskA));

    const result = await runOrchestration(repoRoot, false);

    expect(result.failed).toBe(1);
    expect(result.passed).toBe(0);
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(1);
  });

  // ─── State persistence ────────────────────────────────────────────────────

  test('state.json reflects complete status after all tasks pass', async () => {
    const taskA = makeTask('A');
    await seedTasks([taskA]);

    mockRunTaskLoop.mockResolvedValueOnce(makePassResult(taskA));

    await runOrchestration(repoRoot, false);

    const state = await readJson(orchestratorPaths.state(repoRoot), StateSchema);
    expect(state?.status).toBe('complete');
    expect(state?.current_task_id).toBeNull();
  });

  test('state.json reflects failed status when a task fails', async () => {
    const taskA = makeTask('A');
    await seedTasks([taskA]);

    mockRunTaskLoop.mockResolvedValueOnce(makeFailedResult(taskA));

    await runOrchestration(repoRoot, false);

    const state = await readJson(orchestratorPaths.state(repoRoot), StateSchema);
    expect(state?.status).toBe('failed');
  });

  // ─── Already-passed tasks are skipped ────────────────────────────────────

  test('skips tasks that are already passed without calling runTaskLoop', async () => {
    const passedTask = makeTask('A', { status: 'passed' });
    const pendingTask = makeTask('B', { dependencies: ['A'] });
    await seedTasks([passedTask, pendingTask]);

    mockRunTaskLoop.mockResolvedValueOnce(makePassResult(pendingTask));

    const result = await runOrchestration(repoRoot, false);

    expect(result.passed).toBe(2); // 1 pre-counted + 1 just ran
    // runTaskLoop called only for B, not A
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(1);
    expect(mockRunTaskLoop.mock.calls[0][1]).toBe('B');
  });
});
