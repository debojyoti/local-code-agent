import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { runCommand } from '../core/runner.js';
import { orchestratorPaths } from '../state/paths.js';
import { readJson, writeJson } from '../state/persist.js';
import { ConfigSchema, type Task, type TaskList } from '../state/schemas.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { inspectRepo } from './inspect.js';
import { buildPlanningPrompt } from './prompt.js';
import { extractPlanningOutput, normalizeTasks, type PlanningOutput } from './extract.js';

export interface PlanResult {
  tasksPath: string;
  promptArtifactPath: string;
  rawOutputArtifactPath: string;
  tasks: Task[];
  planningOutput: PlanningOutput;
}

export async function runPlan(repoRoot: string, specPath: string): Promise<PlanResult> {
  const resolvedRepo = resolve(repoRoot);
  const resolvedSpec = resolve(specPath);

  await appendLog(resolvedRepo, null, `plan: starting — repo=${resolvedRepo} spec=${resolvedSpec}`);

  // 1. Read spec
  let spec: string;
  try {
    spec = await readFile(resolvedSpec, 'utf8');
  } catch {
    throw new Error(`Cannot read spec file: ${resolvedSpec}`);
  }

  // 2. Inspect repo
  console.log('  Inspecting repository...');
  const ctx = await inspectRepo(resolvedRepo);

  // 3. Build prompt
  const prompt = buildPlanningPrompt(spec, ctx);
  const promptPath = await saveArtifact(resolvedRepo, 'prompts', null, 'planning-prompt.md', prompt);
  console.log(`  Prompt saved: ${promptPath}`);

  // 4. Run Codex
  console.log('  Running Codex CLI...');
  const codexResult = await runCommand('codex', ['--quiet', prompt], {
    cwd: resolvedRepo,
    timeoutMs: 180_000,
  });

  const rawOutput = formatRawOutput(codexResult.stdout, codexResult.stderr, codexResult.exitCode);
  const rawOutputPath = await saveArtifact(
    resolvedRepo, 'artifacts', null, 'planning-output.md', rawOutput,
  );
  console.log(`  Raw output saved: ${rawOutputPath}`);

  if (!codexResult.ok) {
    throw new Error(
      `Codex CLI failed (exit ${codexResult.exitCode}).\n` +
        `Output saved to: ${rawOutputPath}\n` +
        `stderr: ${codexResult.stderr.slice(0, 300)}`,
    );
  }

  // 5. Extract and normalize
  const planningOutput = extractPlanningOutput(codexResult.stdout);
  const tasks = normalizeTasks(planningOutput);

  // 6. Persist tasks.json
  const now = new Date().toISOString();
  const taskList: TaskList = {
    version: '1',
    created_at: now,
    updated_at: now,
    tasks,
  };
  const tasksPath = orchestratorPaths.tasks(resolvedRepo);
  await writeJson(tasksPath, taskList);

  // 7. Persist inferred commands into config.json
  const configPath = orchestratorPaths.config(resolvedRepo);
  const existingConfig = await readJson(configPath, ConfigSchema) ?? ConfigSchema.parse({ repo_path: resolvedRepo });
  const cmds = planningOutput.recommended_commands;
  const updatedConfig = {
    ...existingConfig,
    repo_path: resolvedRepo,
    spec_path: resolvedSpec,
    lint_command: existingConfig.lint_command || cmds.lint || '',
    test_command: existingConfig.test_command || cmds.test || '',
    typecheck_command: existingConfig.typecheck_command || cmds.typecheck || '',
  };
  await writeJson(configPath, updatedConfig);

  await appendLog(resolvedRepo, null, `plan: complete — ${tasks.length} task(s) saved to ${tasksPath}`);

  return { tasksPath, promptArtifactPath: promptPath, rawOutputArtifactPath: rawOutputPath, tasks, planningOutput };
}

export function formatRawOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = [`<!-- exit code: ${exitCode} -->`];
  if (stdout) parts.push(`## stdout\n\n${stdout}`);
  if (stderr) parts.push(`## stderr\n\n${stderr}`);
  if (parts.length === 1) parts.push('(no output)');
  return parts.join('\n\n');
}
