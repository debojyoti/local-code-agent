import { join } from 'path';

const DIR = '.ai-orchestrator';

export const orchestratorPaths = {
  root: (r: string) => join(r, DIR),
  spec: (r: string) => join(r, DIR, 'spec.md'),
  config: (r: string) => join(r, DIR, 'config.json'),
  state: (r: string) => join(r, DIR, 'state.json'),
  tasks: (r: string) => join(r, DIR, 'tasks.json'),
  runs: (r: string) => join(r, DIR, 'runs'),
  logs: (r: string) => join(r, DIR, 'logs'),
  prompts: (r: string) => join(r, DIR, 'prompts'),
  reviews: (r: string) => join(r, DIR, 'reviews'),
  artifacts: (r: string) => join(r, DIR, 'artifacts'),
  reports: (r: string) => join(r, DIR, 'reports'),
  worktrees: (r: string) => join(r, DIR, 'worktrees'),
};
