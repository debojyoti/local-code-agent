import { tmpdir } from 'os';
import { join } from 'path';
import { rm, writeFile, mkdir, readFile } from 'fs/promises';
import { runCommand } from '../src/core/runner.js';
import { orchestratorPaths } from '../src/state/paths.js';
import {
  taskWorktreePath,
  createWorktree,
  removeWorktree,
  getChangedFiles,
  getDiff,
  commitTask,
} from '../src/git/index.js';

// ─── Shared temp repo ────────────────────────────────────────────────────────

let repoRoot: string;

beforeAll(async () => {
  repoRoot = join(tmpdir(), `orch-git-test-${Date.now()}`);
  await mkdir(repoRoot, { recursive: true });

  await runCommand('git', ['-C', repoRoot, 'init']);
  await runCommand('git', ['-C', repoRoot, 'config', 'user.email', 'test@test.com']);
  await runCommand('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
  await writeFile(join(repoRoot, 'README.md'), '# Test\n');
  await runCommand('git', ['-C', repoRoot, 'add', '-A']);
  await runCommand('git', ['-C', repoRoot, 'commit', '-m', 'initial commit']);
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ─── Naming ──────────────────────────────────────────────────────────────────

describe('naming', () => {
  test('taskWorktreePath is deterministic', () => {
    expect(taskWorktreePath('/repo', 'TASK-001')).toBe(
      '/repo/.ai-orchestrator/worktrees/TASK-001',
    );
  });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe('worktree lifecycle', () => {
  const taskId = 'TASK-001';
  let baseSha: string;
  let wtPath: string;

  test('createWorktree uses the repo checkout directly', async () => {
    const info = await createWorktree(repoRoot, taskId);
    baseSha = info.baseSha;
    wtPath = info.worktreePath;

    expect(info.taskId).toBe(taskId);
    expect(info.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(info.worktreePath).toBe(repoRoot);

    const branchResult = await runCommand('git', ['-C', wtPath, 'branch', '--show-current']);
    expect(branchResult.stdout.trim()).not.toBe('');
  });

  test('createWorktree is idempotent on resume', async () => {
    const info2 = await createWorktree(repoRoot, taskId);
    expect(info2.baseSha).toBe(baseSha);
    expect(info2.worktreePath).toBe(wtPath);
  });

  test('getChangedFiles returns empty list before any changes', async () => {
    const files = await getChangedFiles(wtPath, baseSha);
    expect(files).toEqual([]);
  });

  test('getChangedFiles detects new untracked files', async () => {
    await writeFile(join(wtPath, 'new-file.ts'), 'export const x = 1;\n');
    const files = await getChangedFiles(wtPath, baseSha);
    expect(files).toContain('new-file.ts');
  });

  test('getDiff shows staged new file content', async () => {
    await runCommand('git', ['-C', wtPath, 'add', 'new-file.ts']);
    const diff = await getDiff(wtPath, baseSha);
    expect(diff).toContain('new-file.ts');
    expect(diff).toContain('+export const x = 1;');
  });

  test('commitTask commits all changes and returns a sha', async () => {
    const sha = await commitTask(wtPath, 'test: add new-file.ts');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(baseSha);
  });

  test('getChangedFiles detects committed changes relative to base', async () => {
    const files = await getChangedFiles(wtPath, baseSha);
    expect(files).toContain('new-file.ts');
  });

  test('getDiff shows committed diff relative to base', async () => {
    const diff = await getDiff(wtPath, baseSha);
    expect(diff).toContain('new-file.ts');
  });

  test('removeWorktree deletes the metadata file', async () => {
    await removeWorktree(repoRoot, taskId);
    await expect(readFile(
      join(orchestratorPaths.worktrees(repoRoot), `${taskId}.json`),
      'utf8',
    )).rejects.toThrow();
  });

  test('removeWorktree is safe to call when already removed', async () => {
    await expect(removeWorktree(repoRoot, taskId)).resolves.not.toThrow();
  });
});

// ─── Stale metadata ──────────────────────────────────────────────────────────

describe('stale metadata', () => {
  const taskId = 'TASK-STALE';

  afterEach(async () => {
    // best-effort cleanup so other tests aren't affected
    await removeWorktree(repoRoot, taskId).catch(() => {});
  });

  test('createWorktree rejects reuse when the stored repo does not match the intended repo', async () => {
    // First call records gitRepoPath = repoRoot
    await createWorktree(repoRoot, taskId);

    // Second call with a different gitRepoPath should be rejected loudly,
    // not silently reused. (Workspace-mode scenario: task's repo_id changed.)
    await expect(
      createWorktree(repoRoot, taskId, '/some/other/repo'),
    ).rejects.toThrow(/[Ss]tale|different repo|now targets/);
  });
});
