import { resolve } from 'path';
import { runTask } from './index.js';
import { runReview } from '../review/index.js';
import { loadTask, updateTask } from '../state/tasks.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { ConfigSchema } from '../state/schemas.js';
import { readJson } from '../state/persist.js';
import { orchestratorPaths } from '../state/paths.js';
import type { Task, ReviewVerdict } from '../state/schemas.js';

export type LoopStopReason = 'pass' | 'blocked' | 'retry_limit' | 'failed';

export interface LoopAttempt {
  attemptNum: number;
  executionOk: boolean;
  verdict: ReviewVerdict | null;
}

export interface LoopResult {
  task: Task;
  attempts: LoopAttempt[];
  stoppedReason: LoopStopReason;
}

export async function runTaskLoop(repoRoot: string, taskId: string): Promise<LoopResult> {
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, taskId, 'loop: starting');

  const initialTask = await loadTask(resolvedRepo, taskId);
  const config = await readJson(orchestratorPaths.config(resolvedRepo), ConfigSchema).catch(() => null);
  const maxRetries = initialTask.max_retries ?? config?.max_retries ?? 3;
  const maxAttempts = maxRetries + 1;

  const attempts: LoopAttempt[] = [];
  let fixBrief: string | undefined;

  while (attempts.length < maxAttempts) {
    const attemptNum = attempts.length + 1;
    console.log(`\n  [Loop] Attempt ${attemptNum} / ${maxAttempts}...`);
    await appendLog(resolvedRepo, taskId, `loop: attempt ${attemptNum} starting`);

    // Execute Claude + run checks
    let execRunResult;
    try {
      execRunResult = await runTask(resolvedRepo, taskId, fixBrief ? { fixBrief } : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(resolvedRepo, taskId, `loop: attempt ${attemptNum} execution threw — ${msg}`);
      attempts.push({ attemptNum, executionOk: false, verdict: null });
      return {
        task: await loadTask(resolvedRepo, taskId),
        attempts,
        stoppedReason: 'failed',
      };
    }

    const executionOk = execRunResult.executionResult.ok;

    // Run Codex review
    let reviewRunResult;
    try {
      reviewRunResult = await runReview(resolvedRepo, taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(resolvedRepo, taskId, `loop: attempt ${attemptNum} review threw — ${msg}`);
      attempts.push({ attemptNum, executionOk, verdict: null });
      return {
        task: await loadTask(resolvedRepo, taskId),
        attempts,
        stoppedReason: 'failed',
      };
    }

    const verdict = reviewRunResult.reviewResult.verdict;
    attempts.push({ attemptNum, executionOk, verdict });
    await appendLog(resolvedRepo, taskId, `loop: attempt ${attemptNum} verdict=${verdict} executionOk=${executionOk}`);

    // A PASS verdict is only accepted when the execution itself succeeded.
    // If checks failed, treat it as REVISE so the loop continues.
    if (verdict === 'PASS' && executionOk) {
      return { task: reviewRunResult.task, attempts, stoppedReason: 'pass' };
    }

    if (verdict === 'BLOCKED') {
      return { task: reviewRunResult.task, attempts, stoppedReason: 'blocked' };
    }

    // REVISE (or PASS-with-failed-execution) — check if we have remaining attempts
    if (attempts.length >= maxAttempts) {
      await appendLog(resolvedRepo, taskId, `loop: retry limit reached after ${attempts.length} attempts (max=${maxAttempts})`);
      // Persist terminal failed state so the task is not stuck in 'revise'.
      const currentTask = await loadTask(resolvedRepo, taskId);
      const failedTask: Task = { ...currentTask, status: 'failed', updated_at: new Date().toISOString() };
      await updateTask(resolvedRepo, failedTask);
      return {
        task: failedTask,
        attempts,
        stoppedReason: 'retry_limit',
      };
    }

    // Save fix brief as artifact before next attempt
    const rawFixBrief = reviewRunResult.reviewResult.fix_brief?.trim()
      || '(no specific fix brief provided — address all issues found in the review)';
    const fixBriefPath = await saveArtifact(
      resolvedRepo,
      'prompts',
      taskId,
      `fix-brief-attempt-${attemptNum}.md`,
      rawFixBrief,
    );
    console.log(`  Fix brief saved: ${fixBriefPath}`);
    await appendLog(resolvedRepo, taskId, `loop: fix brief saved — ${fixBriefPath}`);

    fixBrief = rawFixBrief;
  }

  // Should not be reached, but satisfies TypeScript
  return {
    task: await loadTask(resolvedRepo, taskId),
    attempts,
    stoppedReason: 'retry_limit',
  };
}
