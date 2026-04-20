import { mkdir, access, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { orchestratorPaths } from '../state/paths.js';
import { writeWorkspaceManifest, type RepoEntry } from './index.js';

export interface InitWorkspaceResult {
  workspaceRoot: string;
  reposPath: string;
  specPath: string;
  repos: RepoEntry[];
}

export function parseRepoEntries(input: string): RepoEntry[] {
  const items = input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    throw new Error('At least one repo entry is required. Use --repos "frontend=./frontend,backend=./backend"');
  }

  const seen = new Set<string>();
  return items.map((item) => {
    const eq = item.indexOf('=');
    if (eq <= 0 || eq === item.length - 1) {
      throw new Error(
        `Invalid repo entry '${item}'. Use id=path, for example frontend=./frontend`,
      );
    }
    const id = item.slice(0, eq).trim();
    const path = item.slice(eq + 1).trim();
    if (!id || !path) {
      throw new Error(
        `Invalid repo entry '${item}'. Use id=path, for example frontend=./frontend`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate repo id '${id}' in --repos`);
    }
    seen.add(id);
    return { id, path, description: '' };
  });
}

export function buildWorkspaceSpecTemplate(repos: RepoEntry[]): string {
  const repoBullets = repos.map((repo) => `- \`${repo.id}\`: ${repo.path}`).join('\n');

  return `# Workspace Spec

Describe the multi-repo change you want implemented.

Workspace repos:
${repoBullets}

Goals:
- describe the user-visible outcome
- describe the main implementation constraints
- keep the plan grounded

Constraints:
- do not overcomplicate the architecture
- prefer modifying existing modules over introducing new layers
- keep tasks small and repo-specific where possible

Definition of done:
- the required repos are updated
- lint/test/typecheck expectations are clear
- the final behavior is easy to verify
`;
}

export async function initWorkspaceScaffold(
  workspaceRoot: string,
  repos: RepoEntry[],
  force = false,
): Promise<InitWorkspaceResult> {
  const root = resolve(workspaceRoot);
  const aiRoot = orchestratorPaths.root(root);
  const reposPath = orchestratorPaths.repos(root);
  const specPath = orchestratorPaths.spec(root);

  await mkdir(root, { recursive: true });
  await mkdir(aiRoot, { recursive: true });

  if (!force) {
    for (const path of [reposPath, specPath]) {
      try {
        await access(path);
        throw new Error(
          `${path} already exists. Re-run with --force to overwrite the workspace scaffold.`,
        );
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('already exists')) {
          // file does not exist
        } else {
          throw err;
        }
      }
    }
  }

  await writeWorkspaceManifest(root, { version: '1', repos });
  await writeFile(specPath, buildWorkspaceSpecTemplate(repos), 'utf8');

  await Promise.all([
    mkdir(orchestratorPaths.logs(root), { recursive: true }),
    mkdir(orchestratorPaths.prompts(root), { recursive: true }),
    mkdir(orchestratorPaths.artifacts(root), { recursive: true }),
    mkdir(orchestratorPaths.reviews(root), { recursive: true }),
    mkdir(orchestratorPaths.reports(root), { recursive: true }),
    mkdir(orchestratorPaths.worktrees(root), { recursive: true }),
    mkdir(orchestratorPaths.runs(root), { recursive: true }),
  ]);

  return { workspaceRoot: root, reposPath, specPath, repos };
}
