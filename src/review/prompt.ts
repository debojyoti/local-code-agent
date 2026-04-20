import type { Task, CheckOutput } from '../state/schemas.js';

export function buildReviewPrompt(
  task: Task,
  brief: string,
  diff: string,
  changedFiles: string[],
  checks: CheckOutput[],
): string {
  const criteria = task.acceptance_criteria.length > 0
    ? task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none specified)';

  const changedFilesSection = changedFiles.length > 0
    ? changedFiles.map((f) => `- ${f}`).join('\n')
    : '(none)';

  const diffSection = diff ? diff.slice(0, 8000) : '(no changes)';

  const checksSection = checks.length > 0
    ? checks.map((c) => {
        const status = c.ok ? 'PASSED' : 'FAILED';
        const output = [c.stdout, c.stderr].filter(Boolean).join('\n').slice(0, 1500);
        return `### ${c.name} — ${status}\nCommand: \`${c.command}\`\n${output || '(no output)'}`;
      }).join('\n\n')
    : '(no checks run)';

  return `You are reviewing a code implementation task. Evaluate whether the implementation meets the acceptance criteria.

## Task
**ID:** ${task.id}
**Title:** ${task.title}
**Goal:** ${task.goal}

## Acceptance Criteria
${criteria}

## Implementation Brief Given to Claude
${brief.slice(0, 3000)}

## Changed Files
${changedFilesSection}

## Git Diff
\`\`\`diff
${diffSection}
\`\`\`

## Check Results
${checksSection}

---

Return your verdict as a single JSON block. Use EXACTLY this structure:

\`\`\`json
{
  "verdict": "PASS",
  "summary": "one to three sentence summary of the implementation quality",
  "acceptance_checklist": [
    { "criterion": "criterion text", "passed": true }
  ],
  "issues_found": [],
  "fix_brief": "",
  "confidence": 0.9
}
\`\`\`

Verdict values:
- **PASS** — all acceptance criteria met, checks pass, implementation is clean
- **REVISE** — fixable issues found; provide actionable fix_brief with specific instructions
- **BLOCKED** — fundamental blocker that cannot be fixed without human intervention

Rules:
- confidence is a float between 0.0 and 1.0
- fix_brief must be empty string when verdict is PASS
- fix_brief must be specific and actionable when verdict is REVISE
- Return only the JSON block — no extra commentary after it`;
}
