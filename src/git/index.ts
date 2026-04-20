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
 * Create (or resume) the working context for a task.
 *
 * We keep all orchestrator metadata under `workspaceRoot`, but tasks run
 * directly in the target repo checkout so later tasks can see earlier changes
 * on the same branch.
 */
export async function createWorktree(
  workspaceRoot: string,
  taskId: string,
  gitRepoPath?: string,
): Promise<WorktreeInfo> {
  const repoPath = gitRepoPath ?? workspaceRoot;
  const metaPath = worktreeMetaPath(workspaceRoot, taskId);

  // Resume: metadata already exists — verify the recorded repo still matches.
  const existing = await readJson(metaPath, WorktreeInfoSchema);
  if (existing) {
    // Reject reuse if the task now targets a different repo than the one the
    // context was originally created from. Older metadata may lack this field;
    // in that case we skip the check for backwards compatibility.
    if (existing.gitRepoPath && existing.gitRepoPath !== repoPath) {
      throw new Error(
        `Stale worktree metadata for ${taskId}: ` +
          `worktree tracks '${existing.gitRepoPath}' but task now targets '${repoPath}'. ` +
          `Remove ${metaPath} and re-run.`,
      );
    }

    const repoCheck = await runCommand('git', ['-C', repoPath, 'rev-parse', '--git-dir']);
    if (!repoCheck.ok) {
      throw new Error(
        `Stale worktree metadata for ${taskId}: ` +
          `repo missing or not a git repository at '${repoPath}'. ` +
          `Remove ${metaPath} and re-run.`,
      );
    }

    const refreshed: WorktreeInfo = {
      taskId: existing.taskId,
      worktreePath: repoPath,
      baseSha: existing.baseSha,
      gitRepoPath: repoPath,
    };
    if (existing.worktreePath !== repoPath || existing.gitRepoPath !== repoPath) {
      await writeJson(metaPath, refreshed);
    }
    return refreshed;
  }

  // Capture the base commit so diffs are always relative to task start
  const headResult = await runCommand('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
  if (!headResult.ok) {
    throw new Error(`Failed to resolve HEAD: ${headResult.stderr}`);
  }
  const baseSha = headResult.stdout.trim();

  await mkdir(orchestratorPaths.worktrees(workspaceRoot), { recursive: true });

  const info: WorktreeInfo = { taskId, worktreePath: repoPath, baseSha, gitRepoPath: repoPath };
  await writeJson(metaPath, info);
  return info;
}

export async function removeWorktree(
  workspaceRoot: string,
  taskId: string,
  gitRepoPath?: string,
): Promise<void> {
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
    .filter((l) => Boolean(l) && !l.startsWith('.ai-orchestrator/'));

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
