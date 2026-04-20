import { extractReviewResult } from '../src/review/extract.js';
import { buildReviewPrompt } from '../src/review/prompt.js';
import type { Task, CheckOutput } from '../src/state/schemas.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseTask: Task = {
  id: 'TASK-001',
  title: 'Add user schema',
  goal: 'Create a validated user schema with zod',
  status: 'reviewing',
  priority: 1,
  allowed_files: ['src/schemas/user.ts'],
  acceptance_criteria: ['UserSchema validates name and email', 'UserSchema rejects invalid email'],
  implementation_notes: '',
  test_commands: ['npm test'],
  retry_count: 1,
  max_retries: 3,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  dependencies: [],
};

const baseChecks: CheckOutput[] = [
  { name: 'lint', command: 'npm run lint', stdout: '', stderr: '', exit_code: 0, ok: true },
  { name: 'test', command: 'npm test', stdout: 'All tests pass', stderr: '', exit_code: 0, ok: true },
  { name: 'typecheck', command: 'npm run typecheck', stdout: '', stderr: '', exit_code: 0, ok: true },
];

// ─── extractReviewResult ──────────────────────────────────────────────────────

describe('extractReviewResult', () => {
  it('parses a well-formed JSON block', () => {
    const raw = `Here is my review.

\`\`\`json
{
  "verdict": "PASS",
  "summary": "Implementation looks good.",
  "acceptance_checklist": [
    { "criterion": "UserSchema validates name and email", "passed": true },
    { "criterion": "UserSchema rejects invalid email", "passed": true }
  ],
  "issues_found": [],
  "fix_brief": "",
  "confidence": 0.95
}
\`\`\``;

    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.verdict).toBe('PASS');
    expect(result.summary).toBe('Implementation looks good.');
    expect(result.confidence).toBe(0.95);
    expect(result.acceptance_checklist).toHaveLength(2);
    expect(result.acceptance_checklist[0].passed).toBe(true);
    expect(result.issues_found).toHaveLength(0);
    expect(result.fix_brief).toBe('');
    expect(result.task_id).toBe('TASK-001');
    expect(result.attempt).toBe(1);
    expect(result.raw_output).toBe(raw);
  });

  it('parses a REVISE verdict with fix brief', () => {
    const raw = `\`\`\`json
{
  "verdict": "REVISE",
  "summary": "Missing error handling in the schema.",
  "acceptance_checklist": [
    { "criterion": "UserSchema validates name and email", "passed": true },
    { "criterion": "UserSchema rejects invalid email", "passed": false }
  ],
  "issues_found": ["Invalid email check is missing"],
  "fix_brief": "Add email validation using z.string().email()",
  "confidence": 0.8
}
\`\`\``;

    const result = extractReviewResult(raw, 'TASK-001', 2);
    expect(result.verdict).toBe('REVISE');
    expect(result.issues_found).toEqual(['Invalid email check is missing']);
    expect(result.fix_brief).toBe('Add email validation using z.string().email()');
    expect(result.attempt).toBe(2);
  });

  it('parses a BLOCKED verdict', () => {
    const raw = `\`\`\`json
{
  "verdict": "BLOCKED",
  "summary": "Requires a database migration that cannot be automated.",
  "acceptance_checklist": [],
  "issues_found": ["Needs manual DB migration"],
  "fix_brief": "",
  "confidence": 0.99
}
\`\`\``;

    const result = extractReviewResult(raw, 'TASK-002', 1);
    expect(result.verdict).toBe('BLOCKED');
  });

  it('normalizes confidence expressed as a percentage', () => {
    const raw = `\`\`\`json
{
  "verdict": "PASS",
  "summary": "Looks good.",
  "acceptance_checklist": [],
  "issues_found": [],
  "fix_brief": "",
  "confidence": 90
}
\`\`\``;

    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it('falls back gracefully when no JSON block is present', () => {
    const raw = 'I think this REVISE is needed because the tests are not passing.';
    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.verdict).toBe('REVISE');
    expect(result.summary).toContain('not structured JSON');
    expect(result.confidence).toBe(0.3);
    expect(result.raw_output).toBe(raw);
  });

  it('falls back to REVISE when verdict cannot be determined from text', () => {
    const raw = 'The implementation has some concerns that need addressing.';
    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.verdict).toBe('REVISE');
  });

  it('detects PASS from plain text fallback', () => {
    const raw = 'Everything looks fine. The task has PASS criteria met.';
    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.verdict).toBe('PASS');
  });

  it('falls back gracefully for malformed JSON in block', () => {
    const raw = `\`\`\`json
{ "verdict": "REVISE", broken json
\`\`\`
REVISE: fix the broken JSON`;

    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.verdict).toBe('REVISE');
  });

  it('handles acceptance_checklist with plain string items', () => {
    const raw = `\`\`\`json
{
  "verdict": "PASS",
  "summary": "ok",
  "acceptance_checklist": ["criterion one", "criterion two"],
  "issues_found": [],
  "fix_brief": "",
  "confidence": 0.7
}
\`\`\``;

    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.acceptance_checklist).toHaveLength(2);
    expect(result.acceptance_checklist[0].criterion).toBe('criterion one');
    expect(result.acceptance_checklist[0].passed).toBe(false);
  });

  it('extracts JSON from bare object without code fence', () => {
    const raw = `Some preamble.
{
  "verdict": "PASS",
  "summary": "clean",
  "acceptance_checklist": [],
  "issues_found": [],
  "fix_brief": "",
  "confidence": 0.8
}
Some trailing text.`;

    const result = extractReviewResult(raw, 'TASK-001', 1);
    expect(result.verdict).toBe('PASS');
    expect(result.confidence).toBe(0.8);
  });
});

// ─── buildReviewPrompt ────────────────────────────────────────────────────────

describe('buildReviewPrompt', () => {
  it('includes task ID, title, goal', () => {
    const prompt = buildReviewPrompt(baseTask, 'Brief content', 'diff here', ['src/a.ts'], baseChecks);
    expect(prompt).toContain('TASK-001');
    expect(prompt).toContain('Add user schema');
    expect(prompt).toContain('Create a validated user schema with zod');
  });

  it('includes acceptance criteria', () => {
    const prompt = buildReviewPrompt(baseTask, 'Brief content', 'diff here', ['src/a.ts'], baseChecks);
    expect(prompt).toContain('UserSchema validates name and email');
    expect(prompt).toContain('UserSchema rejects invalid email');
  });

  it('includes changed files', () => {
    const prompt = buildReviewPrompt(baseTask, 'Brief', 'diff', ['src/schemas/user.ts'], baseChecks);
    expect(prompt).toContain('src/schemas/user.ts');
  });

  it('includes check results', () => {
    const checks: CheckOutput[] = [
      ...baseChecks.slice(0, 2),
      { name: 'typecheck', command: 'tsc', stdout: '', stderr: 'Type error at line 5', exit_code: 1, ok: false },
    ];
    const prompt = buildReviewPrompt(baseTask, 'Brief', 'diff', [], checks);
    expect(prompt).toContain('FAILED');
    expect(prompt).toContain('Type error at line 5');
  });

  it('handles empty changed files and checks gracefully', () => {
    const prompt = buildReviewPrompt(baseTask, 'Brief', '', [], []);
    expect(prompt).toContain('(none)');
    expect(prompt).toContain('(no checks run)');
  });

  it('truncates very long diffs', () => {
    const longDiff = 'a'.repeat(20000);
    const prompt = buildReviewPrompt(baseTask, 'Brief', longDiff, [], []);
    expect(prompt.length).toBeLessThan(20000);
  });
});
