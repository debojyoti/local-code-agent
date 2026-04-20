import { readFile, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { runCodexPrompt } from '../core/codex.js';
import { orchestratorPaths } from '../state/paths.js';
import { readJson, writeJson } from '../state/persist.js';
import { ConfigSchema, TaskListSchema, type Task, type TaskList } from '../state/schemas.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { extractPlanningOutput, normalizeTasks } from './extract.js';
import { formatRawOutput } from './index.js';

export interface RefineOptions {
  feedback: string;
}

export interface RefineResult {
  tasksPath: string;
  promptArtifactPath: string;
  rawOutputArtifactPath: string;
  tasks: Task[];
  added: string[];
  removed: string[];
  kept: string[];
}

export async function runPlanRefine(repoRoot: string, opts: RefineOptions): Promise<RefineResult> {
  const resolvedRepo = resolve(repoRoot);
  const { feedback } = opts;

  if (!feedback.trim()) {
    throw new Error('Feedback is required. Provide --feedback <text> or --feedback-file <path>.');
  }

  await appendLog(resolvedRepo, null, 'plan-refine: starting');

  // 1. Load spec.md (best-effort — refinement still works without it)
  const specPath = orchestratorPaths.spec(resolvedRepo);
  let spec: string;
  try {
    spec = await readFile(specPath, 'utf8');
  } catch {
    spec = '(spec.md not found)';
  }

  // 2. Load tasks.json — fail clearly if missing
  const tasksPath = orchestratorPaths.tasks(resolvedRepo);
  const taskList = await readJson(tasksPath, TaskListSchema);
  if (!taskList) {
    throw new Error(`tasks.json not found at ${tasksPath} — run 'orchestrator plan' first`);
  }
  const priorTasks = taskList.tasks;

  // 3. Load the latest planning raw output (optional context for Codex)
  const priorOutput = await findLatestPlanningOutput(resolvedRepo);

  // 4. Build refinement prompt
  const prompt = buildRefinementPrompt(spec, priorTasks, priorOutput, feedback);
  const promptPath = await saveArtifact(resolvedRepo, 'prompts', null, 'refine-prompt.md', prompt);
  console.log(`  Prompt saved: ${promptPath}`);

  // 5. Run Codex
  console.log('  Running Codex CLI...');
  const codexResult = await runCodexPrompt(prompt, {
    cwd: resolvedRepo,
    timeoutMs: 180_000,
  });

  const rawOutput = formatRawOutput(codexResult.stdout, codexResult.stderr, codexResult.exitCode);
  const rawOutputPath = await saveArtifact(resolvedRepo, 'artifacts', null, 'refine-output.md', rawOutput);
  console.log(`  Raw output saved: ${rawOutputPath}`);

  if (!codexResult.ok) {
    throw new Error(
      `Codex CLI failed (exit ${codexResult.exitCode}).\n` +
        `Output saved to: ${rawOutputPath}\n` +
        `stderr: ${codexResult.stderr.slice(0, 300)}`,
    );
  }

  // 6. Extract and normalize — reuses the same path as runPlan
  const planningOutput = extractPlanningOutput(codexResult.stdout);
  const freshTasks = normalizeTasks(planningOutput);

  // 7. Merge execution state back into unchanged tasks
  const priorById = new Map(priorTasks.map((t) => [t.id, t]));
  const tasks = freshTasks.map((t) => {
    const prior = priorById.get(t.id);
    return prior ? mergeTaskState(t, prior) : t;
  });

  // 8. Persist refined recommended_commands into config.json (same behavior as runPlan)
  const configPath = orchestratorPaths.config(resolvedRepo);
  const existingConfig =
    (await readJson(configPath, ConfigSchema)) ??
    ConfigSchema.parse({ repo_path: resolvedRepo });
  const cmds = planningOutput.recommended_commands;
  await writeJson(configPath, {
    ...existingConfig,
    lint_command: existingConfig.lint_command || cmds.lint || '',
    test_command: existingConfig.test_command || cmds.test || '',
    typecheck_command: existingConfig.typecheck_command || cmds.typecheck || '',
  });

  // 9. Overwrite tasks.json, preserving the original created_at
  const now = new Date().toISOString();
  const updatedTaskList: TaskList = {
    version: '1',
    created_at: taskList.created_at,
    updated_at: now,
    tasks,
  };
  await writeJson(tasksPath, updatedTaskList);

  // 10. Compute what changed for the terminal summary
  const priorIds = new Set(priorTasks.map((t) => t.id));
  const newIds = new Set(tasks.map((t) => t.id));
  const added = tasks.filter((t) => !priorIds.has(t.id)).map((t) => t.id);
  const removed = priorTasks.filter((t) => !newIds.has(t.id)).map((t) => t.id);
  const kept = tasks.filter((t) => priorIds.has(t.id)).map((t) => t.id);

  await appendLog(
    resolvedRepo,
    null,
    `plan-refine: complete — ${tasks.length} task(s), +${added.length} added, -${removed.length} removed, ~${kept.length} kept`,
  );

  return { tasksPath, promptArtifactPath: promptPath, rawOutputArtifactPath: rawOutputPath, tasks, added, removed, kept };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildRefinementPrompt(
  spec: string,
  currentTasks: Task[],
  priorOutput: string | null,
  feedback: string,
): string {
  const taskLines = currentTasks
    .map((t) =>
      `  { "id": ${JSON.stringify(t.id)}, "title": ${JSON.stringify(t.title)}, "status": ${JSON.stringify(t.status)}, "dependencies": ${JSON.stringify(t.dependencies)} }`,
    )
    .join(',\n');

  const sections: string[] = [];

  sections.push(
    `You are refining an existing implementation plan based on user feedback.\n` +
    `Preserve what is still good. Revise only where the feedback requires it.\n` +
    `Keep tasks small, ordered, and grounded. Do not overcomplicate the architecture.`,
  );

  sections.push(`## Original Specification\n${spec}`);

  sections.push(`## Current Tasks\n\`\`\`json\n[\n${taskLines || '  (none)'}\n]\n\`\`\``);

  if (priorOutput) {
    const truncated = priorOutput.length > 2_000
      ? priorOutput.slice(0, 2_000) + '\n... (truncated)'
      : priorOutput;
    sections.push(`## Prior Planning Context\n${truncated}`);
  }

  sections.push(`## User Feedback\n${feedback}`);

  sections.push(
    `## Your Task\n` +
    `Return the revised plan as ONLY a JSON object in a \`\`\`json code block. Use the same schema:\n\n` +
    `\`\`\`json\n` +
    `{\n` +
    `  "repo_summary": "one-paragraph description",\n` +
    `  "assumptions": [],\n` +
    `  "tasks": [\n` +
    `    {\n` +
    `      "id": "TASK-001",\n` +
    `      "title": "short title",\n` +
    `      "goal": "what this task accomplishes",\n` +
    `      "priority": 1,\n` +
    `      "allowed_files": ["src/example.ts"],\n` +
    `      "acceptance_criteria": ["criterion 1"],\n` +
    `      "implementation_notes": "",\n` +
    `      "test_commands": ["npm test"],\n` +
    `      "dependencies": []\n` +
    `    }\n` +
    `  ],\n` +
    `  "recommended_commands": { "lint": "", "test": "", "typecheck": "" },\n` +
    `  "risks": []\n` +
    `}\n` +
    `\`\`\`\n\n` +
    `Rules:\n` +
    `- Preserve task IDs for unchanged tasks so execution history is not lost\n` +
    `- Order tasks so dependencies come first (lower priority number = earlier)\n` +
    `- Each task should be small enough for a single focused session\n` +
    `- Use empty arrays where information is not applicable`,
  );

  return sections.join('\n\n');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * For a task whose ID exists in the prior plan, restore execution-state fields
 * so that refinement does not reset status or retry history.
 *
 * Content fields (title, goal, allowed_files, acceptance_criteria,
 * implementation_notes) come from the fresh Codex output.
 * Execution fields (status, retry_count, max_retries, created_at) come from
 * the prior task.
 * If the task definition is unchanged: preserve all execution state (status, retry_count,
 * max_retries, created_at, updated_at) so a passing task is not re-run.
 * If the task definition changed in any meaningful way: reset to a fresh runnable state
 * so the task is re-executed with the new definition.
 */
export function mergeTaskState(freshTask: Task, priorTask: Task): Task {
  const taskChanged =
    freshTask.title !== priorTask.title ||
    freshTask.goal !== priorTask.goal ||
    freshTask.priority !== priorTask.priority ||
    freshTask.implementation_notes !== priorTask.implementation_notes ||
    JSON.stringify(freshTask.allowed_files) !== JSON.stringify(priorTask.allowed_files) ||
    JSON.stringify(freshTask.acceptance_criteria) !== JSON.stringify(priorTask.acceptance_criteria) ||
    JSON.stringify(freshTask.test_commands) !== JSON.stringify(priorTask.test_commands) ||
    JSON.stringify(freshTask.dependencies) !== JSON.stringify(priorTask.dependencies);

  if (taskChanged) {
    // Definition changed — reset execution state so the task reruns with the new definition.
    return {
      ...freshTask,
      status: 'pending',
      retry_count: 0,
      max_retries: priorTask.max_retries,
      created_at: priorTask.created_at,
      updated_at: new Date().toISOString(),
    };
  }

  // Unchanged — fully preserve execution state.
  return {
    ...freshTask,
    status: priorTask.status,
    retry_count: priorTask.retry_count,
    max_retries: priorTask.max_retries,
    created_at: priorTask.created_at,
    updated_at: priorTask.updated_at,
  };
}

async function findLatestPlanningOutput(repoRoot: string): Promise<string | null> {
  const dir = orchestratorPaths.artifacts(repoRoot);
  try {
    const files = await readdir(dir);
    const matches = files
      .filter((f) => f.endsWith('planning-output.md'))
      .sort()
      .reverse();
    if (matches.length === 0) return null;
    return readFile(join(dir, matches[0]), 'utf8');
  } catch {
    return null;
  }
}
