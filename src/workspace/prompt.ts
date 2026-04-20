import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { RepoEntry } from './index.js';

export interface InteractiveWorkspaceAnswers {
  workspaceRoot: string;
  repos: RepoEntry[];
  force: boolean;
}

function parseYesNo(value: string, defaultValue: boolean): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultValue;
  return trimmed === 'y' || trimmed === 'yes';
}

export async function promptForWorkspaceInit(defaultRepoPath: string): Promise<InteractiveWorkspaceAnswers> {
  const rl = createInterface({ input, output });

  try {
    output.write('\nInteractive workspace setup\n');
    output.write('Press Enter to accept the default shown in brackets.\n\n');

    const workspaceAnswer = await rl.question(`Workspace root [${defaultRepoPath}]: `);
    const workspaceRoot = workspaceAnswer.trim() || defaultRepoPath;

    const repos: RepoEntry[] = [];
    let index = 1;
    while (true) {
      const id = (await rl.question(`Repo ${index} id${index === 1 ? '' : ' (leave blank to finish)'}: `)).trim();
      if (!id) {
        if (repos.length === 0) {
          output.write('At least one repo is required.\n');
          continue;
        }
        break;
      }

      const path = (await rl.question(`Repo ${index} path: `)).trim();
      if (!path) {
        output.write('Repo path is required.\n');
        continue;
      }

      const description = (await rl.question(`Repo ${index} description (optional): `)).trim();
      repos.push({ id, path, description });
      index += 1;
    }

    const forceAnswer = await rl.question('Overwrite existing repos.json/spec.md if present? [y/N]: ');
    const force = parseYesNo(forceAnswer, false);

    return { workspaceRoot, repos, force };
  } finally {
    rl.close();
  }
}
