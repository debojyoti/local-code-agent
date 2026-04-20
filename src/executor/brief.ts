import type { Task } from '../state/schemas.js';
import type { WorktreeInfo } from '../git/index.js';

export function buildImplementationBrief(
  task: Task,
  worktree: WorktreeInfo,
  fixBrief?: string,
): string {
  const sections: string[] = [];

  sections.push(`# Implementation Brief: ${task.id} — ${task.title}`);

  if (fixBrief) {
    sections.push(`## Fix Required\nA previous implementation attempt was reviewed and requires changes.\nAddress all issues described below before writing any new code.\n\n${fixBrief}`);
  }

  sections.push(`## Context
You are implementing a single focused task directly in the target repo checkout.
Working path: ${worktree.worktreePath}
Git mode: same branch / same checkout

Do not modify files outside the allowed list.
Do not refactor unrelated code.
Summarize exactly what you changed at the end of your response.`);

  sections.push(`## Task
**ID:** ${task.id}
**Title:** ${task.title}
**Goal:** ${task.goal}`);

  if (task.acceptance_criteria.length > 0) {
    const criteria = task.acceptance_criteria.map((c) => `- ${c}`).join('\n');
    sections.push(`## Acceptance Criteria\n${criteria}`);
  }

  if (task.allowed_files.length > 0) {
    const files = task.allowed_files.map((f) => `- ${f}`).join('\n');
    sections.push(`## Allowed Files\nYou may only create or modify these files:\n${files}`);
  }

  if (task.implementation_notes) {
    sections.push(`## Implementation Notes\n${task.implementation_notes}`);
  }

  if (task.dependencies.length > 0) {
    sections.push(`## Dependencies\nThese tasks have already been completed:\n${task.dependencies.map((d) => `- ${d}`).join('\n')}`);
  }

  if (task.test_commands.length > 0) {
    const cmds = task.test_commands.map((c) => `  ${c}`).join('\n');
    sections.push(`## Verification Commands\nAfter implementing, these commands should pass:\n${cmds}`);
  }

  sections.push(`## Required Response Format
At the end of your response, include a section like this:

## Summary of Changes
- <file changed or created>: <one-line description>
- ...`);

  return sections.join('\n\n');
}
