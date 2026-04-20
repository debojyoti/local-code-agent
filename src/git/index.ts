import { join } from 'path';
import { mkdir, unlink } from 'fs/promises';
import { runCommand } from '../core/runner.js';
import { orchestratorPaths } from '../state/paths.js';
import { readJson, writeJson } from '../state/persist.js';
import { z } from 'zod';

export function taskWorktreePath(repoRoot: string, taskId: string): string {
  return join(orchestratorPaths.worktrees(repoRoot), taskId);
}

// ─── WorktreeInfo ─────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  taskId: string;
  worktreePath: string;
  baseSha: string;
}

const WorktreeInfoSchema = z.object({
  taskId: z.string(),
  worktreePath: z.string(),
  baseSha: z.string(),
});

function worktreeMetaPath(repoRoot: string, taskId: string): string {
  return join(orchestratorPaths.worktrees(repoRoot), `${taskId}.json`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function createWorktree(
  repoRoot: string,
  taskId: string,
): Promise<WorktreeInfo> {
  const wtPath = taskWorktreePath(repoRoot, taskId);
  const metaPath = worktreeMetaPath(repoRoot, taskId);

  // Resume: metadata already exists — verify the recorded worktree still exists
  const existing = await readJson(metaPath, WorktreeInfoSchema);
  if (existing) {
    const wtCheck = await runCommand('git', ['-C', existing.worktreePath, 'rev-parse', '--git-dir']);
    const worktreeExists = wtCheck.ok;
    if (!worktreeExists) {
      throw new Error(
        `Stale worktree metadata for ${taskId}: ` +
          `worktree missing. ` +
          `Remove ${metaPath} and re-run to recreate the worktree.`,
      );
    }
    return existing;
  }

  // Capture the base commit so diffs are always relative to task start
  const headResult = await runCommand('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  if (!headResult.ok) {
    throw new Error(`Failed to resolve HEAD: ${headResult.stderr}`);
  }
  const baseSha = headResult.stdout.trim();

  await mkdir(orchestratorPaths.worktrees(repoRoot), { recursive: true });

  // Attach a detached worktree at the current repo HEAD without creating a task branch.
  const wtResult = await runCommand('git', [
    '-C', repoRoot, 'worktree', 'add', '--detach', wtPath, baseSha,
  ]);
  if (!wtResult.ok) {
    throw new Error(`Failed to create worktree at ${wtPath}: ${wtResult.stderr}`);
  }

  const info: WorktreeInfo = { taskId, worktreePath: wtPath, baseSha };
  await writeJson(metaPath, info);
  return info;
}

export async function removeWorktree(repoRoot: string, taskId: string): Promise<void> {
  const wtPath = taskWorktreePath(repoRoot, taskId);

  const removeResult = await runCommand('git', [
    '-C', repoRoot, 'worktree', 'remove', '--force', wtPath,
  ]);
  if (!removeResult.ok) {
    // Worktree may already be gone; prune to keep git's internal list consistent
    await runCommand('git', ['-C', repoRoot, 'worktree', 'prune']);
  }

  const metaPath = worktreeMetaPath(repoRoot, taskId);
  try {
    await unlink(metaPath);
  } catch {
    // metadata already gone — not an error
  }
}

// ─── Inspection ──────────────────────────────────────────────────────────────

export async function getChangedFiles(
  worktreePath: string,
  baseSha: string,
): Promise<string[]> {
  const [committed, unstaged, staged, untracked] = await Promise.all([
    // files changed in commits on this branch since base
    runCommand('git', ['-C', worktreePath, 'diff', '--name-only', baseSha, 'HEAD']),
    // modified tracked files not yet staged
    runCommand('git', ['-C', worktreePath, 'diff', '--name-only']),
    // staged changes
    runCommand('git', ['-C', worktreePath, 'diff', '--cached', '--name-only']),
    // new files not yet tracked
    runCommand('git', ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard']),
  ]);

  const lines = [
    committed.stdout,
    unstaged.stdout,
    staged.stdout,
    untracked.stdout,
  ]
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return [...new Set(lines)];
}

export async function getDiff(worktreePath: string, baseSha: string): Promise<string> {
  const [committed, unstaged, staged] = await Promise.all([
    runCommand('git', ['-C', worktreePath, 'diff', baseSha, 'HEAD']),
    runCommand('git', ['-C', worktreePath, 'diff']),
    runCommand('git', ['-C', worktreePath, 'diff', '--cached']),
  ]);

  return [committed.stdout, staged.stdout, unstaged.stdout]
    .filter(Boolean)
    .join('\n');
}

// ─── Commit ──────────────────────────────────────────────────────────────────

export async function commitTask(
  worktreePath: string,
  message: string,
): Promise<string> {
  const addResult = await runCommand('git', ['-C', worktreePath, 'add', '-A']);
  if (!addResult.ok) {
    throw new Error(`git add failed: ${addResult.stderr}`);
  }

  const commitResult = await runCommand('git', [
    '-C', worktreePath, 'commit', '--allow-empty', '-m', message,
  ]);
  if (!commitResult.ok) {
    throw new Error(`git commit failed: ${commitResult.stderr}`);
  }

  const shaResult = await runCommand('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
  if (!shaResult.ok) {
    throw new Error(`Failed to resolve HEAD after commit: ${shaResult.stderr}`);
  }

  return shaResult.stdout.trim();
}
