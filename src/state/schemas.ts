import { z } from 'zod';

// ─── Task ────────────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.enum([
  'pending',
  'planning',
  'ready',
  'running',
  'reviewing',
  'revise',
  'passed',
  'blocked',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  status: TaskStatusSchema,
  priority: z.number().int().min(1),
  allowed_files: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  implementation_notes: z.string().default(''),
  test_commands: z.array(z.string()),
  retry_count: z.number().int().min(0).default(0),
  max_retries: z.number().int().min(0).default(3),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  dependencies: z.array(z.string()),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskListSchema = z.object({
  version: z.string().default('1'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  tasks: z.array(TaskSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;

// ─── Config ──────────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  version: z.string().default('1'),
  repo_path: z.string(),
  spec_path: z.string().optional(),
  lint_command: z.string().default(''),
  test_command: z.string().default(''),
  typecheck_command: z.string().default(''),
  max_retries: z.number().int().min(0).default(3),
  dry_run: z.boolean().default(false),
  stop_on_blocked: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

// ─── Orchestrator state ───────────────────────────────────────────────────────

export const OrchestratorStatusSchema = z.enum([
  'idle',
  'planning',
  'running',
  'paused',
  'complete',
  'failed',
]);
export type OrchestratorStatus = z.infer<typeof OrchestratorStatusSchema>;

export const StateSchema = z.object({
  version: z.string().default('1'),
  status: OrchestratorStatusSchema,
  current_task_id: z.string().nullable().default(null),
  started_at: z.string().datetime().nullable().default(null),
  updated_at: z.string().datetime(),
});
export type State = z.infer<typeof StateSchema>;

// ─── Execution result ─────────────────────────────────────────────────────────

export const CheckOutputSchema = z.object({
  name: z.string(),
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int(),
  ok: z.boolean(),
});
export type CheckOutput = z.infer<typeof CheckOutputSchema>;

export const ExecutionResultSchema = z.object({
  task_id: z.string(),
  attempt: z.number().int().min(1),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int(),
  ok: z.boolean(),
  changed_files: z.array(z.string()),
  diff: z.string(),
  checks: z.array(CheckOutputSchema),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

// ─── Review result ────────────────────────────────────────────────────────────

export const ReviewVerdictSchema = z.enum(['PASS', 'REVISE', 'BLOCKED']);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewResultSchema = z.object({
  task_id: z.string(),
  attempt: z.number().int().min(1),
  verdict: ReviewVerdictSchema,
  summary: z.string(),
  acceptance_checklist: z.array(
    z.object({ criterion: z.string(), passed: z.boolean() }),
  ),
  issues_found: z.array(z.string()),
  fix_brief: z.string(),
  confidence: z.number().min(0).max(1),
  raw_output: z.string(),
  created_at: z.string().datetime(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// ─── Final report ─────────────────────────────────────────────────────────────

export const FinalReportSchema = z.object({
  version: z.string().default('1'),
  repo_path: z.string(),
  generated_at: z.string().datetime(),
  total_tasks: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  blocked: z.number().int(),
  task_summaries: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: TaskStatusSchema,
      retry_count: z.number().int(),
      verdict: ReviewVerdictSchema.nullable(),
    }),
  ),
  audit_summary: z.string().default(''),
});
export type FinalReport = z.infer<typeof FinalReportSchema>;
