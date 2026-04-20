import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { buildImplementationBrief } from '../src/executor/brief.js';
import { loadTask, updateTask } from '../src/state/tasks.js';
import { writeJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import type { Task } from '../src/state/schemas.js';
import type { WorktreeInfo } from '../src/git/index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date().toISOString();

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'TASK-001',
  title: 'Add authentication',
  goal: 'Implement JWT-based auth middleware',
  status: 'pending',
  priority: 1,
  allowed_files: ['src/auth.ts', 'src/middleware.ts'],
  acceptance_criteria: ['tokens are validated', 'invalid tokens return 401'],
  implementation_notes: 'Use the jsonwebtoken library.',
  test_commands: ['npm test', 'npm run typecheck'],
  retry_count: 0,
  max_retries: 3,
  created_at: now,
  updated_at: now,
  dependencies: [],
  ...overrides,
});

const worktree: WorktreeInfo = {
  taskId: 'TASK-001',
  worktreePath: '/tmp/repo/.ai-orchestrator/worktrees/TASK-001',
  baseSha: 'abc1234def5678',
};

// ─── buildImplementationBrief ─────────────────────────────────────────────────

describe('buildImplementationBrief', () => {
  test('includes task id and title in header', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain('TASK-001');
    expect(brief).toContain('Add authentication');
  });

  test('includes worktree path and same checkout mode', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain(worktree.worktreePath);
    expect(brief).toContain('same branch / same checkout');
  });

  test('includes acceptance criteria', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain('tokens are validated');
    expect(brief).toContain('invalid tokens return 401');
  });

  test('includes allowed files', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain('src/auth.ts');
    expect(brief).toContain('src/middleware.ts');
  });

  test('includes implementation notes when present', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain('jsonwebtoken');
  });

  test('omits implementation notes section when empty', () => {
    const brief = buildImplementationBrief(makeTask({ implementation_notes: '' }), worktree);
    expect(brief).not.toContain('Implementation Notes');
  });

  test('includes test commands when present', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain('npm test');
    expect(brief).toContain('npm run typecheck');
  });

  test('includes dependencies when present', () => {
    const brief = buildImplementationBrief(makeTask({ dependencies: ['TASK-000'] }), worktree);
    expect(brief).toContain('TASK-000');
  });

  test('omits dependencies section when empty', () => {
    const brief = buildImplementationBrief(makeTask({ dependencies: [] }), worktree);
    expect(brief).not.toContain('Dependencies');
  });

  test('requests a summary of changes section', () => {
    const brief = buildImplementationBrief(makeTask(), worktree);
    expect(brief).toContain('Summary of Changes');
  });
});

// ─── loadTask / updateTask ────────────────────────────────────────────────────

describe('task state helpers', () => {
  const repoRoot = join(tmpdir(), `orch-tasks-test-${Date.now()}`);

  beforeAll(async () => {
    const taskList = {
      version: '1',
      created_at: now,
      updated_at: now,
      tasks: [makeTask(), makeTask({ id: 'TASK-002', title: 'Add tests', priority: 2 })],
    };
    await writeJson(orchestratorPaths.tasks(repoRoot), taskList);
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test('loadTask returns the correct task', async () => {
    const task = await loadTask(repoRoot, 'TASK-001');
    expect(task.id).toBe('TASK-001');
    expect(task.title).toBe('Add authentication');
  });

  test('loadTask throws for unknown task id', async () => {
    await expect(loadTask(repoRoot, 'TASK-999')).rejects.toThrow('TASK-999');
  });

  test('updateTask persists a status change', async () => {
    const task = await loadTask(repoRoot, 'TASK-001');
    await updateTask(repoRoot, { ...task, status: 'running' });
    const reloaded = await loadTask(repoRoot, 'TASK-001');
    expect(reloaded.status).toBe('running');
  });

  test('updateTask does not affect other tasks', async () => {
    const task = await loadTask(repoRoot, 'TASK-001');
    await updateTask(repoRoot, { ...task, status: 'reviewing' });
    const other = await loadTask(repoRoot, 'TASK-002');
    expect(other.status).toBe('pending');
  });

  test('updateTask throws for unknown task id', async () => {
    const task = makeTask({ id: 'TASK-UNKNOWN' });
    await expect(updateTask(repoRoot, task)).rejects.toThrow('TASK-UNKNOWN');
  });
});
