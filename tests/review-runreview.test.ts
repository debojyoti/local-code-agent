/**
 * Integration tests for runReview().
 * runCommand is mocked so no real Codex CLI is needed.
 * State helpers and artifact writes use the real filesystem (temp directory).
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';

import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { TaskListSchema, ExecutionResultSchema } from '../src/state/schemas.js';

// ─── Module mock (declared before any import of review) ──────────────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const repoRoot = join(tmpdir(), `orch-review-test-${Date.now()}`);

const baseTask = {
  id: 'TASK-001',
  title: 'Add user schema',
  goal: 'Create a validated user schema with zod',
  status: 'reviewing' as const,
  priority: 1,
  allowed_files: ['src/schemas/user.ts'],
  acceptance_criteria: ['UserSchema validates name and email'],
  implementation_notes: '',
  test_commands: ['npm test'],
  retry_count: 1,
  max_retries: 3,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  dependencies: [],
};

const baseExecutionResult = {
  task_id: 'TASK-001',
  attempt: 1,
  stdout: 'done',
  stderr: '',
  exit_code: 0,
  ok: true,
  changed_files: ['src/schemas/user.ts'],
  diff: '+export const UserSchema = z.object({});\n',
  checks: [
    { name: 'lint', command: 'npm run lint', stdout: '', stderr: '', exit_code: 0, ok: true },
    { name: 'test', command: 'npm test', stdout: 'pass', stderr: '', exit_code: 0, ok: true },
    { name: 'typecheck', command: 'tsc', stdout: '', stderr: '', exit_code: 0, ok: true },
  ],
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
};

const passReviewOutput = JSON.stringify({
  verdict: 'PASS',
  summary: 'Implementation meets all criteria.',
  acceptance_checklist: [{ criterion: 'UserSchema validates name and email', passed: true }],
  issues_found: [],
  fix_brief: '',
  confidence: 0.95,
});

const reviseReviewOutput = JSON.stringify({
  verdict: 'REVISE',
  summary: 'Missing email validation.',
  acceptance_checklist: [{ criterion: 'UserSchema validates name and email', passed: false }],
  issues_found: ['Email field missing .email() refinement'],
  fix_brief: 'Add z.string().email() to the email field.',
  confidence: 0.8,
});

async function resetState(taskStatus = 'reviewing' as const): Promise<void> {
  const now = new Date().toISOString();
  await writeJson(orchestratorPaths.tasks(repoRoot), {
    version: '1',
    created_at: now,
    updated_at: now,
    tasks: [{ ...baseTask, status: taskStatus, updated_at: now }],
  });

  // Write a real execution result artifact so findLatestExecutionResult can load it
  const artifactDir = join(orchestratorPaths.artifacts(repoRoot), 'TASK-001');
  await writeJson(
    join(artifactDir, 'execution-result-attempt-1.json'),
    baseExecutionResult,
  );
}

async function currentTaskStatus(): Promise<string | undefined> {
  const list = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
  return list?.tasks.find((t) => t.id === 'TASK-001')?.status;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runReview', () => {
  let runReview: (repoRoot: string, taskId: string) => Promise<import('../src/review/index.js').ReviewRunResult>;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    const reviewMod = await import('../src/review/index.js');
    runReview = reviewMod.runReview;

    const runnerMod = await import('../src/core/runner.js');
    mockRunCommand = runnerMod.runCommand as jest.Mock;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await resetState();
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ─── Success paths ────────────────────────────────────────────────────────

  test('transitions task to passed when Codex returns PASS', async () => {
    mockRunCommand.mockResolvedValue({
      stdout: '```json\n' + passReviewOutput + '\n```',
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runReview(repoRoot, 'TASK-001');

    expect(result.reviewResult.verdict).toBe('PASS');
    expect(result.task.status).toBe('passed');
    expect(await currentTaskStatus()).toBe('passed');
  });

  test('transitions task to revise when Codex returns REVISE', async () => {
    mockRunCommand.mockResolvedValue({
      stdout: '```json\n' + reviseReviewOutput + '\n```',
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runReview(repoRoot, 'TASK-001');

    expect(result.reviewResult.verdict).toBe('REVISE');
    expect(result.task.status).toBe('revise');
    expect(await currentTaskStatus()).toBe('revise');
  });

  test('transitions task to blocked when Codex returns BLOCKED', async () => {
    const blockedOutput = JSON.stringify({
      verdict: 'BLOCKED',
      summary: 'Needs manual DB migration.',
      acceptance_checklist: [],
      issues_found: ['Requires DBA access'],
      fix_brief: '',
      confidence: 0.99,
    });

    mockRunCommand.mockResolvedValue({
      stdout: '```json\n' + blockedOutput + '\n```',
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runReview(repoRoot, 'TASK-001');

    expect(result.reviewResult.verdict).toBe('BLOCKED');
    expect(result.task.status).toBe('blocked');
    expect(await currentTaskStatus()).toBe('blocked');
  });

  test('persists review result JSON and returns artifact paths', async () => {
    mockRunCommand.mockResolvedValue({
      stdout: '```json\n' + passReviewOutput + '\n```',
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runReview(repoRoot, 'TASK-001');

    expect(result.promptPath).toBeTruthy();
    expect(result.rawOutputPath).toBeTruthy();
    expect(result.reviewResultPath).toBeTruthy();

    // The persisted file should be readable and valid
    const { readFile } = await import('fs/promises');
    const raw = await readFile(result.reviewResultPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.task_id).toBe('TASK-001');
    expect(parsed.attempt).toBe(1);
  });

  test('uses the attempt number from the execution result', async () => {
    mockRunCommand.mockResolvedValue({
      stdout: '```json\n' + passReviewOutput + '\n```',
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runReview(repoRoot, 'TASK-001');
    expect(result.reviewResult.attempt).toBe(1);
  });

  // ─── Failure / stuck-in-reviewing guard ──────────────────────────────────

  test('task is set to failed (not stuck in reviewing) when Codex invocation throws', async () => {
    mockRunCommand.mockRejectedValue(new Error('Codex process crashed'));

    await expect(runReview(repoRoot, 'TASK-001')).rejects.toThrow('Codex process crashed');

    const status = await currentTaskStatus();
    expect(status).toBe('failed');
    expect(status).not.toBe('reviewing');
  });

  test('original error is rethrown after the stuck-in-reviewing guard fires', async () => {
    mockRunCommand.mockRejectedValue(new Error('timeout'));

    await expect(runReview(repoRoot, 'TASK-001')).rejects.toThrow('timeout');
  });

  // ─── Missing execution result ─────────────────────────────────────────────

  test('throws before marking reviewing when no execution result exists', async () => {
    // Use a fresh task ID that has no artifact directory at all
    const now = new Date().toISOString();
    await writeJson(orchestratorPaths.tasks(repoRoot), {
      version: '1',
      created_at: now,
      updated_at: now,
      tasks: [
        { ...baseTask, id: 'TASK-002', status: 'pending' as const, retry_count: 0, updated_at: now },
      ],
    });

    await expect(runReview(repoRoot, 'TASK-002')).rejects.toThrow(/run.*run-task/i);

    // Task must not have been moved to reviewing
    const list = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
    expect(list?.tasks.find((t) => t.id === 'TASK-002')?.status).toBe('pending');
  });
});
