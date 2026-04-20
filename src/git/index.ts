import { join } from 'path';
import { mkdir, unlink } from 'fs/promises';
import { runCommand } from '../core/runner.js';
import { orchestratorPaths } from '../state/paths.js';
import { readJson, writeJson } from '../state/persist.js';
import { z } from 'zod';

export function taskWorktreePath(workspaceRoot: string, taskId: string): string {
  return join(orchestratorPaths.worktrees(workspaceRoot), taskId);
}

// ─── WorktreeInfo ─────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  taskId: string;
  worktreePath: string;
  baseSha: string;
  // Git repo this worktree was created from. Recorded so that in workspace mode
  // we can reject reuse when a task's repo_id now points at a different repo.
  // Optional in the schema for backwards compatibility with pre-Step-17 metadata.
  gitRepoPath?: string;
}

const WorktreeInfoSchema = z.object({
  taskId: z.string(),
  worktreePath: z.string(),
  baseSha: z.string(),
  gitRepoPath: z.string().optional(),
});

function worktreeMetaPath(workspaceRoot: string, taskId: string): string {
  return join(orchestratorPaths.worktrees(workspaceRoot), `${taskId}.json`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Create (or resume) a detached worktree for a task.
 *
 * `workspaceRoot` is where `.ai-orchestrator/` lives — artifacts, metadata, and
 * the worktree directory are all rooted here. `gitRepoPath` is the git repo the
 * worktree actually tracks; in single-repo mode it is the same as `workspaceRoot`,
 * in workspace mode it is the child repo resolved from the task's `repo_id`.
 */
export async function createWorktree(
  workspaceRoot: string,
  taskId: string,
  gitRepoPath?: string,
): Promise<WorktreeInfo> {
  const repoPath = gitRepoPath ?? workspaceRoot;
  const wtPath = taskWorktreePath(workspaceRoot, taskId);
  const metaPath = worktreeMetaPath(workspaceRoot, taskId);

  // Resume: metadata already exists — verify the recorded worktree still exists
  // AND still tracks the same git repo the caller now intends.
  const existing = await readJson(metaPath, WorktreeInfoSchema);
  if (existing) {
    // Reject reuse if the task now targets a different repo than the one the
    // worktree was originally created from. Older metadata may lack this field;
    // in that case we skip the check for backwards compatibility.
    if (existing.gitRepoPath && existing.gitRepoPath !== repoPath) {
      throw new Error(
        `Stale worktree metadata for ${taskId}: ` +
          `worktree tracks '${existing.gitRepoPath}' but task now targets '${repoPath}'. ` +
          `Remove ${metaPath} (and the worktree at ${existing.worktreePath}) and re-run.`,
      );
    }

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
  const headResult = await runCommand('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
  if (!headResult.ok) {
    throw new Error(`Failed to resolve HEAD: ${headResult.stderr}`);
  }
  const baseSha = headResult.stdout.trim();

  await mkdir(orchestratorPaths.worktrees(workspaceRoot), { recursive: true });

  // Attach a detached worktree at the current repo HEAD without creating a task branch.
  const wtResult = await runCommand('git', [
    '-C', repoPath, 'worktree', 'add', '--detach', wtPath, baseSha,
  ]);
  if (!wtResult.ok) {
    throw new Error(`Failed to create worktree at ${wtPath}: ${wtResult.stderr}`);
  }

  const info: WorktreeInfo = { taskId, worktreePath: wtPath, baseSha, gitRepoPath: repoPath };
  await writeJson(metaPath, info);
  return info;
}

export async function removeWorktree(
  workspaceRoot: string,
  taskId: string,
  gitRepoPath?: string,
): Promise<void> {
  const repoPath = gitRepoPath ?? workspaceRoot;
  const wtPath = taskWorktreePath(workspaceRoot, taskId);

  const removeResult = await runCommand('git', [
    '-C', repoPath, 'worktree', 'remove', '--force', wtPath,
  ]);
  if (!removeResult.ok) {
    // Worktree may already be gone; prune to keep git's internal list consistent
    await runCommand('git', ['-C', repoPath, 'worktree', 'prune']);
  }

  const metaPath = worktreeMetaPath(workspaceRoot, taskId);
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
