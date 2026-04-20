import { resolve } from 'path';
import { runCommand } from '../core/runner.js';
import { loadTask, updateTask } from '../state/tasks.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { createWorktree, getChangedFiles, getDiff } from '../git/index.js';
import {
  type Task,
  type ExecutionResult,
} from '../state/schemas.js';
import { writeJson } from '../state/persist.js';
import { orchestratorPaths } from '../state/paths.js';
import { join } from 'path';
import { buildImplementationBrief } from './brief.js';

export interface RunTaskResult {
  task: Task;
  executionResult: ExecutionResult;
  briefPath: string;
  claudeOutputPath: string;
  executionResultPath: string;
}

export async function runTask(repoRoot: string, taskId: string): Promise<RunTaskResult> {
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, taskId, `run-task: starting`);

  // 1. Load task
  const task = await loadTask(resolvedRepo, taskId);
  if (task.status === 'passed') {
    throw new Error(`Task ${taskId} has already passed. Use --force to re-run.`);
  }

  // 2. Create or reuse worktree
  console.log(`  Creating worktree for ${taskId}...`);
  const worktree = await createWorktree(resolvedRepo, taskId);
  console.log(`  Worktree: ${worktree.worktreePath}`);

  // 3. Mark task as running
  const startedAt = new Date().toISOString();
  const runningTask: Task = { ...task, status: 'running', updated_at: startedAt };
  await updateTask(resolvedRepo, runningTask);

  // From here any unexpected throw must transition the task out of 'running'.
  try {
    // 4. Build and save the implementation brief
    const brief = buildImplementationBrief(task, worktree);
    const briefPath = await saveArtifact(resolvedRepo, 'prompts', taskId, 'implementation-brief.md', brief);
    console.log(`  Brief saved: ${briefPath}`);

    // 5. Invoke Claude Code CLI in the worktree
    console.log(`  Running Claude Code CLI...`);
    const claudeResult = await runCommand('claude', ['--print', brief], {
      cwd: worktree.worktreePath,
      timeoutMs: 300_000,
    });

    const completedAt = new Date().toISOString();

    // 6. Save Claude's raw output
    const claudeOutput = [
      `<!-- exit code: ${claudeResult.exitCode} -->`,
      claudeResult.stdout ? `## stdout\n\n${claudeResult.stdout}` : '',
      claudeResult.stderr ? `## stderr\n\n${claudeResult.stderr}` : '',
    ].filter(Boolean).join('\n\n');

    const claudeOutputPath = await saveArtifact(
      resolvedRepo, 'artifacts', taskId, 'claude-output.md', claudeOutput,
    );
    console.log(`  Claude output saved: ${claudeOutputPath}`);

    // 7. Capture changed files and diff
    const [changedFiles, diff] = await Promise.all([
      getChangedFiles(worktree.worktreePath, worktree.baseSha),
      getDiff(worktree.worktreePath, worktree.baseSha),
    ]);

    // 8. Build and persist execution result
    const attempt = task.retry_count + 1;
    const executionResult: ExecutionResult = {
      task_id: taskId,
      attempt,
      stdout: claudeResult.stdout,
      stderr: claudeResult.stderr,
      exit_code: claudeResult.exitCode,
      ok: claudeResult.ok,
      changed_files: changedFiles,
      diff,
      checks: [], // populated in Step 8
      started_at: startedAt,
      completed_at: completedAt,
    };

    const executionResultPath = join(
      orchestratorPaths.artifacts(resolvedRepo),
      taskId,
      `execution-result-attempt-${attempt}.json`,
    );
    await writeJson(executionResultPath, executionResult);
    console.log(`  Execution result saved: ${executionResultPath}`);

    // 9. Update task state
    const nextStatus = claudeResult.ok ? 'reviewing' : 'failed';
    const doneTask: Task = {
      ...runningTask,
      status: nextStatus,
      retry_count: attempt,
      updated_at: completedAt,
    };
    await updateTask(resolvedRepo, doneTask);

    await appendLog(
      resolvedRepo, taskId,
      `run-task: complete — status=${nextStatus} changed=${changedFiles.length} files exit=${claudeResult.exitCode}`,
    );

    return { task: doneTask, executionResult, briefPath, claudeOutputPath, executionResultPath };

  } catch (err) {
    // Best-effort: move task out of 'running' so it can be retried or inspected.
    const failedTask: Task = { ...runningTask, status: 'failed', updated_at: new Date().toISOString() };
    await updateTask(resolvedRepo, failedTask).catch(() => {});
    await appendLog(resolvedRepo, taskId, `run-task: unexpected error — ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    throw err;
  }
}
