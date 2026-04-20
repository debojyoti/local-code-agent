import { resolve, join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { runCommand } from '../core/runner.js';
import { loadTask, updateTask } from '../state/tasks.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { orchestratorPaths } from '../state/paths.js';
import { readJson, writeJson } from '../state/persist.js';
import { ExecutionResultSchema, type Task, type ReviewResult } from '../state/schemas.js';
import { buildReviewPrompt } from './prompt.js';
import { extractReviewResult } from './extract.js';

export interface ReviewRunResult {
  task: Task;
  reviewResult: ReviewResult;
  promptPath: string;
  rawOutputPath: string;
  reviewResultPath: string;
}

export async function runReview(repoRoot: string, taskId: string): Promise<ReviewRunResult> {
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, taskId, `review: starting`);

  // 1. Load task
  const task = await loadTask(resolvedRepo, taskId);

  // 2. Find latest execution result (contains diff, changed_files, checks)
  const executionResult = await findLatestExecutionResult(resolvedRepo, taskId);
  if (!executionResult) {
    throw new Error(
      `No execution result found for task ${taskId} — run 'orchestrator run-task --task ${taskId}' first`,
    );
  }

  // 3. Find latest implementation brief
  const brief = await findLatestBrief(resolvedRepo, taskId);

  // 4. Build review prompt
  const prompt = buildReviewPrompt(
    task,
    brief,
    executionResult.diff,
    executionResult.changed_files,
    executionResult.checks,
  );
  const promptPath = await saveArtifact(resolvedRepo, 'prompts', taskId, 'review-prompt.md', prompt);
  console.log(`  Review prompt saved: ${promptPath}`);

  // 5. Mark task as reviewing
  const reviewingTask: Task = { ...task, status: 'reviewing', updated_at: new Date().toISOString() };
  await updateTask(resolvedRepo, reviewingTask);

  // From here any unexpected throw must move the task out of 'reviewing'.
  try {
    // 6. Invoke Codex CLI
    console.log('  Running Codex CLI...');
    const codexResult = await runCommand('codex', ['--quiet', prompt], {
      cwd: resolvedRepo,
      timeoutMs: 180_000,
    });

    // 7. Save raw output
    const rawOutput = formatRawOutput(codexResult.stdout, codexResult.stderr, codexResult.exitCode);
    const rawOutputPath = await saveArtifact(resolvedRepo, 'reviews', taskId, 'review-raw.md', rawOutput);
    console.log(`  Raw review saved: ${rawOutputPath}`);

    // 8. Parse structured review result
    const reviewResult = extractReviewResult(codexResult.stdout, taskId, executionResult.attempt);

    // 9. Persist normalized review result JSON
    const reviewDir = join(orchestratorPaths.reviews(resolvedRepo), taskId);
    const reviewResultPath = join(reviewDir, `review-result-attempt-${executionResult.attempt}.json`);
    await writeJson(reviewResultPath, reviewResult);
    console.log(`  Review result saved: ${reviewResultPath}`);

    // 10. Transition task state based on verdict
    const verdictStatus = verdictToStatus(reviewResult.verdict);
    const updatedTask: Task = {
      ...reviewingTask,
      status: verdictStatus,
      updated_at: new Date().toISOString(),
    };
    await updateTask(resolvedRepo, updatedTask);

    await appendLog(
      resolvedRepo,
      taskId,
      `review: complete — verdict=${reviewResult.verdict} confidence=${reviewResult.confidence} status=${verdictStatus}`,
    );

    return { task: updatedTask, reviewResult, promptPath, rawOutputPath, reviewResultPath };

  } catch (err) {
    const failedTask: Task = { ...reviewingTask, status: 'failed', updated_at: new Date().toISOString() };
    await updateTask(resolvedRepo, failedTask).catch(() => {});
    await appendLog(resolvedRepo, taskId, `review: unexpected error — ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function verdictToStatus(verdict: ReviewResult['verdict']): Task['status'] {
  switch (verdict) {
    case 'PASS':    return 'passed';
    case 'REVISE':  return 'revise';
    case 'BLOCKED': return 'blocked';
  }
}

async function findLatestExecutionResult(repoRoot: string, taskId: string) {
  const dir = join(orchestratorPaths.artifacts(repoRoot), taskId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  const matches = files
    .filter((f) => f.includes('execution-result-attempt-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (matches.length === 0) return null;
  return readJson(join(dir, matches[0]), ExecutionResultSchema);
}

async function findLatestBrief(repoRoot: string, taskId: string): Promise<string> {
  const dir = join(orchestratorPaths.prompts(repoRoot), taskId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return '(implementation brief not found)';
  }

  const matches = files
    .filter((f) => f.includes('implementation-brief.md'))
    .sort()
    .reverse();

  if (matches.length === 0) return '(implementation brief not found)';

  return readFile(join(dir, matches[0]), 'utf8').catch(() => '(implementation brief not found)');
}

function formatRawOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = [`<!-- exit code: ${exitCode} -->`];
  if (stdout) parts.push(`## stdout\n\n${stdout}`);
  if (stderr) parts.push(`## stderr\n\n${stderr}`);
  if (parts.length === 1) parts.push('(no output)');
  return parts.join('\n\n');
}
