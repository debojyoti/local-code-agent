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
