import type { RepoContext } from './inspect.js';

export function buildPlanningPrompt(spec: string, ctx: RepoContext): string {
  const sections: string[] = [];

  sections.push(`You are analyzing a software repository to create an ordered implementation plan.`);

  sections.push(`## Repository
Path: ${ctx.repoPath}
Recent commits:
${ctx.gitLog}

Top-level structure:
${ctx.topLevelItems.join('\n')}`);

  if (ctx.packageJson) {
    sections.push(`## package.json\n\`\`\`json\n${ctx.packageJson}\n\`\`\``);
  }

  if (ctx.readme) {
    sections.push(`## README\n${ctx.readme}`);
  }

  sections.push(`## Specification\n${spec}`);

  sections.push(`## Task

Analyze the repository and specification above.
Return ONLY a JSON object wrapped in a \`\`\`json code block. No text before or after the block.

Required structure:
\`\`\`json
{
  "repo_summary": "one-paragraph description of the repo",
  "assumptions": ["assumption 1"],
  "tasks": [
    {
      "id": "TASK-001",
      "title": "short title",
      "goal": "what this task accomplishes",
      "priority": 1,
      "allowed_files": ["src/example.ts"],
      "acceptance_criteria": ["criterion 1"],
      "implementation_notes": "optional hints",
      "test_commands": ["npm test"],
      "dependencies": []
    }
  ],
  "recommended_commands": {
    "lint": "npm run lint",
    "test": "npm test",
    "typecheck": "npm run typecheck"
  },
  "risks": ["risk description"]
}
\`\`\`

Rules:
- Order tasks so dependencies come first (lower priority number = earlier)
- Each task should be small enough to implement in a single focused session
- allowed_files must list only the files the implementer should touch
- acceptance_criteria must be concrete and verifiable
- Use empty arrays where information is not inferable`);

  return sections.join('\n\n');
}
