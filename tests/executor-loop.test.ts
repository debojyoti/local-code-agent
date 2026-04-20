/**
 * Integration tests for runTaskLoop().
 * runTask and runReview are mocked so no real CLIs are needed.
 * State helpers and artifact writes use the real filesystem (temp dir).
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readdir } from 'fs/promises';

import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { TaskListSchema } from '../src/state/schemas.js';
import type { RunTaskResult } from '../src/executor/index.js';
import type { ReviewRunResult } from '../src/review/index.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/executor/index.js', () => ({
  runTask: jest.fn(),
}));

jest.unstable_mockModule('../src/review/index.js', () => ({
  runReview: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const repoRoot = join(tmpdir(), `orch-loop-test-${Date.now()}`);

const baseTask = {
  id: 'TASK-001',
  title: 'Add feature',
  goal: 'Implement the feature',
  status: 'ready' as const,
  priority: 1,
  allowed_files: ['src/feature.ts'],
  acceptance_criteria: ['Feature works'],
  implementation_notes: '',
  test_commands: ['npm test'],
  retry_count: 0,
  max_retries: 2,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  dependencies: [],
};

function makeTask(overrides: Partial<typeof baseTask>) {
  return { ...baseTask, ...overrides, updated_at: new Date().toISOString() };
}

function makeExecResult(overrides: Partial<{ ok: boolean; attempt: number }> = {}): RunTaskResult {
  const attempt = overrides.attempt ?? 1;
  return {
    task: makeTask({ status: 'reviewing', retry_count: attempt }),
    executionResult: {
      task_id: 'TASK-001',
      attempt,
      stdout: 'done',
      stderr: '',
      exit_code: 0,
      ok: overrides.ok ?? true,
      changed_files: ['src/feature.ts'],
      diff: '+// feature\n',
      checks: [],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    },
    briefPath: '/fake/brief.md',
    claudeOutputPath: '/fake/output.md',
    executionResultPath: '/fake/result.json',
  };
}

function makeReviewResult(
  verdict: 'PASS' | 'REVISE' | 'BLOCKED',
  attempt = 1,
  fixBrief = 'Fix the issues.',
): ReviewRunResult {
  const statusMap = { PASS: 'passed', REVISE: 'revise', BLOCKED: 'blocked' } as const;
  return {
    task: makeTask({ status: statusMap[verdict], retry_count: attempt }),
    reviewResult: {
      task_id: 'TASK-001',
      attempt,
      verdict,
      summary: `Verdict: ${verdict}`,
      acceptance_checklist: [],
      issues_found: verdict === 'REVISE' ? ['Issue found'] : [],
      fix_brief: verdict === 'REVISE' ? fixBrief : '',
      confidence: 0.9,
      raw_output: verdict,
      created_at: new Date().toISOString(),
    },
    promptPath: '/fake/prompt.md',
    rawOutputPath: '/fake/raw.md',
    reviewResultPath: '/fake/review-result.json',
  };
}

async function seedTask(overrides: Partial<typeof baseTask> = {}) {
  const now = new Date().toISOString();
  await writeJson(orchestratorPaths.tasks(repoRoot), {
    version: '1',
    created_at: now,
    updated_at: now,
    tasks: [makeTask(overrides)],
  });
}

async function currentTask() {
  const list = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
  return list?.tasks.find((t) => t.id === 'TASK-001');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runTaskLoop', () => {
  let runTaskLoop: (repoRoot: string, taskId: string) => Promise<import('../src/executor/loop.js').LoopResult>;
  let mockRunTask: jest.Mock;
  let mockRunReview: jest.Mock;

  beforeAll(async () => {
    const loopMod = await import('../src/executor/loop.js');
    runTaskLoop = loopMod.runTaskLoop;

    const executorMod = await import('../src/executor/index.js');
    mockRunTask = executorMod.runTask as jest.Mock;

    const reviewMod = await import('../src/review/index.js');
    mockRunReview = reviewMod.runReview as jest.Mock;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await seedTask({ status: 'ready', retry_count: 0 });
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ─── PASS on first attempt ────────────────────────────────────────────────

  test('stops with "pass" when review returns PASS on first attempt', async () => {
    mockRunTask.mockResolvedValue(makeExecResult({ attempt: 1 }));
    mockRunReview.mockResolvedValue(makeReviewResult('PASS', 1));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('pass');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].verdict).toBe('PASS');
    expect(mockRunTask).toHaveBeenCalledTimes(1);
    expect(mockRunReview).toHaveBeenCalledTimes(1);
  });

  // ─── BLOCKED on first attempt ─────────────────────────────────────────────

  test('stops with "blocked" when review returns BLOCKED', async () => {
    mockRunTask.mockResolvedValue(makeExecResult({ attempt: 1 }));
    mockRunReview.mockResolvedValue(makeReviewResult('BLOCKED', 1));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('blocked');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].verdict).toBe('BLOCKED');
    expect(mockRunTask).toHaveBeenCalledTimes(1);
    expect(mockRunReview).toHaveBeenCalledTimes(1);
  });

  // ─── REVISE → PASS ───────────────────────────────────────────────────────

  test('retries after REVISE and stops with "pass" on second attempt', async () => {
    mockRunTask
      .mockResolvedValueOnce(makeExecResult({ attempt: 1 }))
      .mockResolvedValueOnce(makeExecResult({ attempt: 2 }));
    mockRunReview
      .mockResolvedValueOnce(makeReviewResult('REVISE', 1, 'Add missing validation'))
      .mockResolvedValueOnce(makeReviewResult('PASS', 2));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('pass');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].verdict).toBe('REVISE');
    expect(result.attempts[1].verdict).toBe('PASS');
    expect(mockRunTask).toHaveBeenCalledTimes(2);
    expect(mockRunReview).toHaveBeenCalledTimes(2);
  });

  // ─── Fix brief is passed to subsequent runTask calls ─────────────────────

  test('passes fix brief to runTask on retry attempt', async () => {
    mockRunTask
      .mockResolvedValueOnce(makeExecResult({ attempt: 1 }))
      .mockResolvedValueOnce(makeExecResult({ attempt: 2 }));
    mockRunReview
      .mockResolvedValueOnce(makeReviewResult('REVISE', 1, 'Use z.string().email()'))
      .mockResolvedValueOnce(makeReviewResult('PASS', 2));

    await runTaskLoop(repoRoot, 'TASK-001');

    // First call: no options or no fixBrief
    const firstCallOpts = mockRunTask.mock.calls[0][2];
    expect(firstCallOpts?.fixBrief).toBeFalsy();

    // Second call: fix brief from review
    const secondCallOpts = mockRunTask.mock.calls[1][2];
    expect(secondCallOpts?.fixBrief).toBe('Use z.string().email()');
  });

  // ─── Fix brief is persisted as artifact ───────────────────────────────────

  test('saves fix brief artifact before each revise attempt', async () => {
    const promptDir = join(orchestratorPaths.prompts(repoRoot), 'TASK-001');

    // Count existing fix briefs before this test
    let before: string[] = [];
    try { before = (await readdir(promptDir)).filter((f) => f.includes('fix-brief-attempt-')); }
    catch { /* dir may not exist yet */ }

    mockRunTask
      .mockResolvedValueOnce(makeExecResult({ attempt: 1 }))
      .mockResolvedValueOnce(makeExecResult({ attempt: 2 }));
    mockRunReview
      .mockResolvedValueOnce(makeReviewResult('REVISE', 1, 'Fix the schema'))
      .mockResolvedValueOnce(makeReviewResult('PASS', 2));

    await runTaskLoop(repoRoot, 'TASK-001');

    const after = (await readdir(promptDir)).filter((f) => f.includes('fix-brief-attempt-'));
    const added = after.filter((f) => !before.includes(f));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('fix-brief-attempt-1');
  });

  // ─── Retry limit ──────────────────────────────────────────────────────────

  test('stops with "retry_limit" after exhausting max_retries', async () => {
    // max_retries = 2 → max 3 attempts total
    mockRunTask.mockResolvedValue(makeExecResult({ attempt: 1 }));
    mockRunReview.mockResolvedValue(makeReviewResult('REVISE', 1, 'Still wrong'));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('retry_limit');
    expect(result.attempts).toHaveLength(3); // max_retries + 1
    expect(mockRunTask).toHaveBeenCalledTimes(3);
    expect(mockRunReview).toHaveBeenCalledTimes(3);
  });

  test('persists task status as "failed" when retry limit is reached', async () => {
    mockRunTask.mockResolvedValue(makeExecResult({ attempt: 1 }));
    mockRunReview.mockResolvedValue(makeReviewResult('REVISE', 1, 'Still wrong'));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('retry_limit');
    expect(result.task.status).toBe('failed');

    // Persisted state must also reflect failed, not revise
    const persisted = await currentTask();
    expect(persisted?.status).toBe('failed');
  });

  // ─── PASS with failed execution is not accepted ───────────────────────────

  test('does not stop as "pass" when review returns PASS but execution failed', async () => {
    // Attempt 1: execution fails, review incorrectly returns PASS
    // Attempt 2+: execution succeeds, review returns PASS → real pass
    mockRunTask
      .mockResolvedValueOnce(makeExecResult({ attempt: 1, ok: false }))
      .mockResolvedValue(makeExecResult({ attempt: 2, ok: true }));
    mockRunReview
      .mockResolvedValueOnce(makeReviewResult('PASS', 1))   // ignored — exec failed
      .mockResolvedValue(makeReviewResult('PASS', 2));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('pass');
    // Must have taken at least 2 attempts (first PASS was rejected)
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(result.attempts[0].executionOk).toBe(false);
    expect(result.attempts[0].verdict).toBe('PASS');
    // Loop must not have returned after the first attempt
    expect(mockRunTask).toHaveBeenCalledTimes(2);
  });

  test('loops PASS-with-failed-execution until retry limit if execution never recovers', async () => {
    // All attempts: execution fails, review returns PASS — should exhaust retries
    mockRunTask.mockResolvedValue(makeExecResult({ attempt: 1, ok: false }));
    mockRunReview.mockResolvedValue(makeReviewResult('PASS', 1));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('retry_limit');
    expect(result.attempts).toHaveLength(3); // max_retries + 1
    expect(result.task.status).toBe('failed');
  });

  // ─── Execution failure ────────────────────────────────────────────────────

  test('stops with "failed" when runTask throws', async () => {
    mockRunTask.mockRejectedValue(new Error('Claude CLI crashed'));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].verdict).toBeNull();
    expect(result.attempts[0].executionOk).toBe(false);
    expect(mockRunReview).not.toHaveBeenCalled();
  });

  // ─── Review failure ───────────────────────────────────────────────────────

  test('stops with "failed" when runReview throws', async () => {
    mockRunTask.mockResolvedValue(makeExecResult({ attempt: 1 }));
    mockRunReview.mockRejectedValue(new Error('Codex CLI crashed'));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.stoppedReason).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].verdict).toBeNull();
    expect(mockRunTask).toHaveBeenCalledTimes(1);
  });

  // ─── Attempt traceability ─────────────────────────────────────────────────

  test('attempt array records attemptNum, executionOk, and verdict for each attempt', async () => {
    mockRunTask
      .mockResolvedValueOnce(makeExecResult({ attempt: 1, ok: false }))
      .mockResolvedValueOnce(makeExecResult({ attempt: 2, ok: true }));
    mockRunReview
      .mockResolvedValueOnce(makeReviewResult('REVISE', 1))
      .mockResolvedValueOnce(makeReviewResult('PASS', 2));

    const result = await runTaskLoop(repoRoot, 'TASK-001');

    expect(result.attempts[0]).toMatchObject({ attemptNum: 1, executionOk: false, verdict: 'REVISE' });
    expect(result.attempts[1]).toMatchObject({ attemptNum: 2, executionOk: true, verdict: 'PASS' });
  });
});
