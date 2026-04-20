import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { readJson, writeJson } from '../src/state/persist.js';
import {
  TaskSchema,
  TaskListSchema,
  ConfigSchema,
  StateSchema,
  ExecutionResultSchema,
  ReviewResultSchema,
} from '../src/state/schemas.js';

const tmp = join(tmpdir(), `orch-test-${Date.now()}`);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('persist', () => {
  test('writeJson + readJson round-trips a config', async () => {
    const file = join(tmp, 'config.json');
    const data = ConfigSchema.parse({ repo_path: '/tmp/myrepo', max_retries: 5 });
    await writeJson(file, data);
    const result = await readJson(file, ConfigSchema);
    expect(result).toEqual(data);
  });

  test('readJson returns null for missing file', async () => {
    const result = await readJson(join(tmp, 'missing.json'), ConfigSchema);
    expect(result).toBeNull();
  });

  test('readJson throws on malformed JSON text', async () => {
    const file = join(tmp, 'malformed.json');
    const { writeFile } = await import('fs/promises');
    await writeFile(file, '{ not valid json !!!', 'utf8');
    await expect(readJson(file, ConfigSchema)).rejects.toThrow(SyntaxError);
  });

  test('readJson throws on schema validation failure', async () => {
    const file = join(tmp, 'wrong-shape.json');
    await writeJson(file, { completely: 'wrong', shape: true });
    await expect(readJson(file, ConfigSchema)).rejects.toThrow();
  });
});

describe('schemas', () => {
  const now = new Date().toISOString();

  test('TaskSchema parses a valid task', () => {
    const task = TaskSchema.parse({
      id: 'TASK-001',
      title: 'Add auth',
      goal: 'Implement JWT auth',
      status: 'pending',
      priority: 1,
      allowed_files: ['src/auth.ts'],
      acceptance_criteria: ['tokens are validated'],
      implementation_notes: '',
      test_commands: ['npm test'],
      retry_count: 0,
      max_retries: 3,
      created_at: now,
      updated_at: now,
      dependencies: [],
    });
    expect(task.id).toBe('TASK-001');
  });

  test('TaskSchema rejects an invalid status', () => {
    expect(() =>
      TaskSchema.parse({
        id: 'T', title: 'T', goal: 'G', status: 'unknown',
        priority: 1, allowed_files: [], acceptance_criteria: [],
        test_commands: [], created_at: now, updated_at: now, dependencies: [],
      }),
    ).toThrow();
  });

  test('TaskSchema accepts repo_id when present', () => {
    const task = TaskSchema.parse({
      id: 'TASK-002', title: 'Multi-repo task', goal: 'Do something',
      status: 'pending', priority: 1, allowed_files: [], acceptance_criteria: [],
      test_commands: [], created_at: now, updated_at: now, dependencies: [],
      repo_id: 'backend',
    });
    expect(task.repo_id).toBe('backend');
  });

  test('TaskSchema leaves repo_id undefined when absent (single-repo compat)', () => {
    const task = TaskSchema.parse({
      id: 'TASK-003', title: 'Single-repo task', goal: 'Do something',
      status: 'pending', priority: 1, allowed_files: [], acceptance_criteria: [],
      test_commands: [], created_at: now, updated_at: now, dependencies: [],
    });
    expect(task.repo_id).toBeUndefined();
  });

  test('ConfigSchema applies defaults', () => {
    const config = ConfigSchema.parse({ repo_path: '/tmp/repo' });
    expect(config.max_retries).toBe(3);
    expect(config.dry_run).toBe(false);
    expect(config.stop_on_blocked).toBe(true);
  });

  test('StateSchema parses a valid state', () => {
    const state = StateSchema.parse({
      status: 'idle',
      updated_at: now,
    });
    expect(state.current_task_id).toBeNull();
    expect(state.version).toBe('1');
  });

  test('ReviewResultSchema rejects invalid verdict', () => {
    expect(() =>
      ReviewResultSchema.parse({
        task_id: 'T', attempt: 1, verdict: 'MAYBE',
        summary: '', acceptance_checklist: [], issues_found: [],
        fix_brief: '', confidence: 0.9, raw_output: '', created_at: now,
      }),
    ).toThrow();
  });

  test('ExecutionResultSchema parses a valid result', () => {
    const result = ExecutionResultSchema.parse({
      task_id: 'TASK-001', attempt: 1,
      stdout: 'ok', stderr: '', exit_code: 0, ok: true,
      changed_files: ['src/foo.ts'], diff: '--- a\n+++ b',
      checks: [{ name: 'lint', command: 'eslint .', stdout: '', stderr: '', exit_code: 0, ok: true }],
      started_at: now, completed_at: now,
    });
    expect(result.ok).toBe(true);
  });

  test('TaskListSchema parses a list', () => {
    const list = TaskListSchema.parse({
      created_at: now, updated_at: now, tasks: [],
    });
    expect(list.version).toBe('1');
    expect(list.tasks).toHaveLength(0);
  });
});
