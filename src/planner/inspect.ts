import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { runCommand } from '../core/runner.js';
import type { WorkspaceManifest } from '../workspace/index.js';
import { resolveRepoPath } from '../workspace/index.js';

export interface RepoContext {
  repoPath: string;
  gitLog: string;
  topLevelItems: string[];
  packageJson: string | null;
  readme: string | null;
}

export interface WorkspaceRepoContext extends RepoContext {
  repoId: string;
}

export interface WorkspaceContext {
  workspaceRoot: string;
  repos: WorkspaceRepoContext[];
}

export async function inspectWorkspace(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
): Promise<WorkspaceContext> {
  // Validate all repos upfront — fail loudly on any bad entry before building context.
  const validations = await Promise.all(
    manifest.repos.map(async (entry) => {
      const repoPath = resolveRepoPath(workspaceRoot, entry);
      const check = await runCommand('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']);
      return check.ok
        ? null
        : `  [${entry.id}] '${repoPath}' is not a git repository or does not exist`;
    }),
  );
  const errors = validations.filter((e): e is string => e !== null);
  if (errors.length > 0) {
    throw new Error(`Workspace repo validation failed:\n${errors.join('\n')}`);
  }

  const repos = await Promise.all(
    manifest.repos.map(async (entry) => {
      const repoPath = resolveRepoPath(workspaceRoot, entry);
      const ctx = await inspectRepo(repoPath);
      return { ...ctx, repoId: entry.id };
    }),
  );
  return { workspaceRoot, repos };
}

export async function inspectRepo(repoRoot: string): Promise<RepoContext> {
  const [gitLogResult, entries] = await Promise.all([
    runCommand('git', ['-C', repoRoot, 'log', '--oneline', '-10']),
    readdir(repoRoot).catch(() => [] as string[]),
  ]);

  const topLevelItems = entries.filter((e) => !e.startsWith('.') && e !== 'node_modules');

  const [packageJson, readme] = await Promise.all([
    readTextFile(join(repoRoot, 'package.json'), 4_000),
    readTextFile(join(repoRoot, 'README.md'), 3_000),
  ]);

  return {
    repoPath: repoRoot,
    gitLog: gitLogResult.stdout.trim() || '(no commits)',
    topLevelItems,
    packageJson,
    readme,
  };
}

async function readTextFile(path: string, maxChars: number): Promise<string | null> {
  try {
    const content = await readFile(path, 'utf8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n... (truncated)' : content;
  } catch {
    return null;
  }
}
