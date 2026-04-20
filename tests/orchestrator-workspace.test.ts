/**
 * Tests for multi-repo orchestration via runOrchestration().
 *
 * Covers:
 * - Cross-repo dependency ordering: a task in repo A can depend on a task in repo B
 *   and the orchestrator runs them in dependency order regardless of repo.
 * - Run/resume terminal summaries include each task's `repo_id`.
 * - Already-passed tasks across repos are skipped (not re-run).
 * - Stuck `running` / `reviewing` tasks in workspace mode are reset on resume.
 *
 * runTaskLoop is mocked; state and filesystem use a real temp dir.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, unlink } from 'fs/promises';

import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { TaskListSchema } from '../src/state/schemas.js';
import type { Task } from '../src/state/schemas.js';
import type { LoopResult } from '../src/executor/loop.js';

// ─── Module mock ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/executor/loop.js', () => ({
  runTaskLoop: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const workspaceRoot = join(tmpdir(), `orch-ws-test-${Date.now()}`);
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

async function seedTasks(tasks: Task[]) {
  await writeJson(orchestratorPaths.tasks(workspaceRoot), {
    version: '1',
    created_at: NOW,
    updated_at: NOW,
    tasks,
  });
}

async function seedManifest(repos: Array<{ id: string; path: string }>) {
  await writeJson(orchestratorPaths.repos(workspaceRoot), {
    version: '1',
    repos: repos.map((r) => ({ ...r, description: '' })),
  });
}

async function seedState(status: string, currentTaskId: string | null = null) {
  await writeJson(orchestratorPaths.state(workspaceRoot), {
    version: '1',
    status,
    current_task_id: currentTaskId,
    started_at: NOW,
    updated_at: NOW,
  });
}

async function readTasks() {
  const list = await readJson(orchestratorPaths.tasks(workspaceRoot), TaskListSchema);
  return list?.tasks ?? [];
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runOrchestration workspace mode', () => {
  let runOrchestration: typeof import('../src/core/orchestrator.js').runOrchestration;
  let mockRunTaskLoop: jest.Mock;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  const loggedLines: string[] = [];

  beforeAll(async () => {
    ({ runOrchestration } = await import('../src/core/orchestrator.js'));
    const loopMod = await import('../src/executor/loop.js');
    mockRunTaskLoop = loopMod.runTaskLoop as jest.Mock;

    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      loggedLines.push(args.map(String).join(' '));
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    loggedLines.length = 0;
  });

  afterEach(async () => {
    await unlink(orchestratorPaths.config(workspaceRoot)).catch(() => {});
  });

  afterAll(async () => {
    logSpy.mockRestore();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // ─── Cross-repo dependency ordering ───────────────────────────────────────

  test('respects dependencies across repos (B@repoA depends on A@repoB)', async () => {
    // seedManifest declares both repos; topoSort must walk the cross-repo edge.
    await seedManifest([
      { id: 'repoA', path: join(workspaceRoot, 'repoA') },
      { id: 'repoB', path: join(workspaceRoot, 'repoB') },
    ]);

    const taskA = makeTask('A', { repo_id: 'repoB' });
    const taskB = makeTask('B', { repo_id: 'repoA', dependencies: ['A'] });
    // Seed in reverse order — topological sort must pick A first, not insertion order.
    await seedTasks([taskB, taskA]);

    mockRunTaskLoop
      .mockResolvedValueOnce(makePassResult(taskA))
      .mockResolvedValueOnce(makePassResult(taskB));

    const result = await runOrchestration(workspaceRoot, false);

    expect(result.passed).toBe(2);
    const callOrder = mockRunTaskLoop.mock.calls.map((c) => c[1] as string);
    expect(callOrder).toEqual(['A', 'B']);
  });

  // ─── repo_id is surfaced in terminal output ───────────────────────────────

  test('run summary lines include each task\'s repo_id', async () => {
    await seedManifest([
      { id: 'repoA', path: join(workspaceRoot, 'repoA') },
      { id: 'repoB', path: join(workspaceRoot, 'repoB') },
    ]);

    const taskA = makeTask('A', { repo_id: 'repoA' });
    const taskB = makeTask('B', { repo_id: 'repoB' });
    await seedTasks([taskA, taskB]);

    mockRunTaskLoop
      .mockResolvedValueOnce(makePassResult(taskA))
      .mockResolvedValueOnce(makePassResult(taskB));

    await runOrchestration(workspaceRoot, false);

    const logged = loggedLines.join('\n');
    expect(logged).toContain('[repoA]');
    expect(logged).toContain('[repoB]');
    // Both task headers should be visible in the log stream.
    expect(logged).toMatch(/Task\s+\[repoA\]\s+A/);
    expect(logged).toMatch(/Task\s+\[repoB\]\s+B/);
  });

  test('stop-on-blocked summary line for a workspace task includes the repo_id', async () => {
    await seedManifest([{ id: 'repoA', path: join(workspaceRoot, 'repoA') }]);

    const taskA = makeTask('A', { repo_id: 'repoA' });
    await seedTasks([taskA]);
    // default stop_on_blocked=true

    mockRunTaskLoop.mockResolvedValueOnce(makeBlockedResult(taskA));

    await runOrchestration(workspaceRoot, false);

    const logged = loggedLines.join('\n');
    // "Stopping: task [repoA] A  Task A is BLOCKED ..."
    expect(logged).toMatch(/Stopping:\s+task\s+\[repoA\]\s+A\b.*is BLOCKED/);
  });

  test('resume reset line for a workspace task includes the repo_id', async () => {
    await seedManifest([{ id: 'repoA', path: join(workspaceRoot, 'repoA') }]);

    const stuck = makeTask('T1', { repo_id: 'repoA', status: 'running' });
    await seedTasks([stuck]);
    await seedState('paused', 'T1');

    mockRunTaskLoop.mockResolvedValueOnce(makePassResult(stuck));

    await runOrchestration(workspaceRoot, true);

    const logged = loggedLines.join('\n');
    expect(logged).toMatch(/Resetting stuck task\s+\[repoA\]\s+T1/);
  });

  // ─── Already-passed tasks across repos are skipped ────────────────────────

  test('already-passed tasks across multiple repos are not re-run', async () => {
    await seedManifest([
      { id: 'repoA', path: join(workspaceRoot, 'repoA') },
      { id: 'repoB', path: join(workspaceRoot, 'repoB') },
    ]);

    const passedA = makeTask('A', { repo_id: 'repoA', status: 'passed' });
    const passedB = makeTask('B', { repo_id: 'repoB', status: 'passed' });
    const pendingC = makeTask('C', { repo_id: 'repoA', dependencies: ['A', 'B'] });
    await seedTasks([passedA, passedB, pendingC]);

    mockRunTaskLoop.mockResolvedValueOnce(makePassResult(pendingC));

    const result = await runOrchestration(workspaceRoot, false);

    // 2 pre-counted + 1 just ran
    expect(result.passed).toBe(3);
    expect(mockRunTaskLoop).toHaveBeenCalledTimes(1);
    expect(mockRunTaskLoop.mock.calls[0][1]).toBe('C');

    const logged = loggedLines.join('\n');
    // "[skip]  [repoA] A  Task A  (already passed)"
    expect(logged).toMatch(/\[skip\]\s+\[repoA\]\s+A\b.*\(already passed\)/);
    expect(logged).toMatch(/\[skip\]\s+\[repoB\]\s+B\b.*\(already passed\)/);
  });

  // ─── Stuck-task reset in workspace mode ───────────────────────────────────

  test('resume resets stuck running/reviewing tasks in workspace mode back to pending', async () => {
    await seedManifest([
      { id: 'repoA', path: join(workspaceRoot, 'repoA') },
      { id: 'repoB', path: join(workspaceRoot, 'repoB') },
    ]);

    const stuckRunning = makeTask('T1', { repo_id: 'repoA', status: 'running' });
    const stuckReviewing = makeTask('T2', { repo_id: 'repoB', status: 'reviewing' });
    await seedTasks([stuckRunning, stuckReviewing]);
    await seedState('paused');

    mockRunTaskLoop
      .mockResolvedValueOnce(makePassResult(stuckRunning))
      .mockResolvedValueOnce(makePassResult(stuckReviewing));

    await runOrchestration(workspaceRoot, true);

    // Both stuck tasks should have been reset and re-queued for runTaskLoop.
    const calledIds = mockRunTaskLoop.mock.calls.map((c) => c[1] as string).sort();
    expect(calledIds).toEqual(['T1', 'T2']);

    // tasks.json shows pending because runTaskLoop is mocked and does not update state.
    // The reset itself is what this test is verifying.
    const tasks = await readTasks();
    expect(tasks.find((t) => t.id === 'T1')?.status).toBe('pending');
    expect(tasks.find((t) => t.id === 'T2')?.status).toBe('pending');
  });
});
