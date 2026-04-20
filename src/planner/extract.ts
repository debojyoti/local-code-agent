import { z } from 'zod';
import type { Task } from '../state/schemas.js';

// ─── Raw Codex output schema ──────────────────────────────────────────────────
// Codex returns tasks without orchestrator-managed fields (status, timestamps, etc.)

const RawTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  priority: z.number().int().min(1).default(1),
  allowed_files: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  implementation_notes: z.string().default(''),
  test_commands: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  repo_id: z.string().optional(),
});

const RecommendedCommandsSchema = z.object({
  lint: z.string().optional(),
  test: z.string().optional(),
  typecheck: z.string().optional(),
}).default({});

export const PlanningOutputSchema = z.object({
  repo_summary: z.string().default(''),
  assumptions: z.array(z.string()).default([]),
  tasks: z.array(RawTaskSchema),
  recommended_commands: RecommendedCommandsSchema,
  risks: z.array(z.string()).default([]),
});

export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;

// ─── Extractor ───────────────────────────────────────────────────────────────

/**
 * Extract and validate the planning JSON from raw Codex output.
 * Tries the first ```json ... ``` block, then falls back to parsing the whole string.
 * Throws with a descriptive message if nothing parseable is found.
 */
export function extractPlanningOutput(raw: string): PlanningOutput {
  const candidate = extractJsonBlock(raw) ?? raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error(
      `Codex output did not contain parseable JSON.\n` +
        `Raw output (first 500 chars):\n${raw.slice(0, 500)}`,
    );
  }

  try {
    return PlanningOutputSchema.parse(parsed);
  } catch (err) {
    throw new Error(
      `Codex JSON did not match expected planning schema: ${String(err)}\n` +
        `Parsed object: ${JSON.stringify(parsed).slice(0, 500)}`,
    );
  }
}

/** Pull the content of the first ```json ... ``` block, or null if none. */
function extractJsonBlock(text: string): string | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

// ─── Normalizer ──────────────────────────────────────────────────────────────

/** Add orchestrator-managed fields to raw Codex tasks to produce valid Task objects. */
export function normalizeTasks(output: PlanningOutput): Task[] {
  const now = new Date().toISOString();
  return output.tasks.map((raw) => ({
    ...raw,
    status: 'pending' as const,
    retry_count: 0,
    max_retries: 3,
    created_at: now,
    updated_at: now,
  }));
}

/**
 * Validate that every task in a workspace plan has a repo_id that belongs to
 * the declared set. Throws with a descriptive message on the first violation.
 */
export function validateWorkspaceTaskRepoIds(tasks: Task[], knownRepoIds: string[]): void {
  for (const task of tasks) {
    if (!task.repo_id) {
      throw new Error(
        `Task '${task.id}' is missing repo_id. ` +
          `Each workspace task must set repo_id to one of: ${knownRepoIds.join(', ')}`,
      );
    }
    if (!knownRepoIds.includes(task.repo_id)) {
      throw new Error(
        `Task '${task.id}' has unknown repo_id '${task.repo_id}'. ` +
          `Valid values: ${knownRepoIds.join(', ')}`,
      );
    }
  }
}
