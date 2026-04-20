import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { runCommand } from '../core/runner.js';

export interface RepoContext {
  repoPath: string;
  gitLog: string;
  topLevelItems: string[];
  packageJson: string | null;
  readme: string | null;
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
