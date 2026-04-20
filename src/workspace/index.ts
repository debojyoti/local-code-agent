import { z } from 'zod';
import { resolve, join } from 'path';
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { orchestratorPaths } from '../state/paths.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const RepoEntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  description: z.string().default(''),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export const WorkspaceManifestSchema = z.object({
  version: z.string().default('1'),
  repos: z.array(RepoEntrySchema),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function isWorkspaceRoot(rootPath: string): Promise<boolean> {
  try {
    await access(orchestratorPaths.repos(rootPath));
    return true;
  } catch {
    return false;
  }
}

export async function readWorkspaceManifest(rootPath: string): Promise<WorkspaceManifest> {
  const manifestPath = orchestratorPaths.repos(rootPath);
  const raw = await readFile(manifestPath, 'utf8');
  return WorkspaceManifestSchema.parse(JSON.parse(raw));
}

export async function writeWorkspaceManifest(rootPath: string, manifest: WorkspaceManifest): Promise<void> {
  const dir = orchestratorPaths.root(rootPath);
  await mkdir(dir, { recursive: true });
  const manifestPath = orchestratorPaths.repos(rootPath);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

export function resolveRepoPath(workspaceRoot: string, entry: RepoEntry): string {
  if (entry.path.startsWith('/')) return entry.path;
  return resolve(join(workspaceRoot, entry.path));
}

/**
 * Resolve a task's target repo path, loading the workspace manifest from disk
 * if one exists. In single-repo mode (no `repos.json`), returns `workspaceRoot`.
 * In workspace mode, the manifest is loaded and the task's `repo_id` is looked up.
 *
 * Throws a clear error when:
 * - the workspace manifest is present but the task has no `repo_id`,
 * - the task's `repo_id` is not declared in the manifest.
 */
export async function resolveRepoPathForTask(
  workspaceRoot: string,
  task: { repo_id?: string },
): Promise<string> {
  const isWorkspace = await isWorkspaceRoot(workspaceRoot);
  const manifest = isWorkspace ? await readWorkspaceManifest(workspaceRoot) : undefined;
  return resolveTaskRepoPath(workspaceRoot, task, manifest);
}

/**
 * Resolve the filesystem path for the repo a task targets.
 *
 * - No repo_id (single-repo mode): returns workspaceRoot as-is.
 * - repo_id present but no manifest: throws — caller must load the manifest first.
 * - repo_id present with manifest: looks up the entry and resolves its path.
 */
export function resolveTaskRepoPath(
  workspaceRoot: string,
  task: { repo_id?: string },
  manifest?: WorkspaceManifest,
): string {
  if (!task.repo_id) {
    if (manifest) {
      throw new Error(
        `Task has no repo_id but a workspace manifest is present — set repo_id to one of: ${manifest.repos.map((r) => r.id).join(', ')}`,
      );
    }
    // Single-repo mode: the root is the repo.
    return workspaceRoot;
  }
  if (!manifest) {
    throw new Error(
      `Task has repo_id '${task.repo_id}' but no workspace manifest was provided`,
    );
  }
  const entry = manifest.repos.find((r) => r.id === task.repo_id);
  if (!entry) {
    throw new Error(
      `repo_id '${task.repo_id}' not found in workspace manifest`,
    );
  }
  return resolveRepoPath(workspaceRoot, entry);
}
