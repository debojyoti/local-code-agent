import { resolve } from 'path';
import { runCommand } from '../core/runner.js';
import { loadTask, updateTask } from '../state/tasks.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { createWorktree, getChangedFiles, getDiff } from '../git/index.js';
import {
  ConfigSchema,
  type Task,
  type ExecutionResult,
} from '../state/schemas.js';
import { readJson, writeJson } from '../state/persist.js';
import { orchestratorPaths } from '../state/paths.js';
import { join } from 'path';
import { buildImplementationBrief } from './brief.js';
import { runChecks } from './checks.js';
import { resolveRepoPathForTask } from '../workspace/index.js';

export interface RunTaskResult {
  task: Task;
  executionResult: ExecutionResult;
  briefPath: string;
  claudeOutputPath: string;
  executionResultPath: string;
}

export interface RunTaskOptions {
  fixBrief?: string;
}

export async function runTask(repoRoot: string, taskId: string, opts?: RunTaskOptions): Promise<RunTaskResult> {
  // `resolvedRepo` is the state root — where `.ai-orchestrator/` lives.
  // In single-repo mode it is also the git repo; in workspace mode it is the
  // workspace root and the actual git repo is resolved per task from `repo_id`.
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, taskId, `run-task: starting`);

  // 1. Load task
  const task = await loadTask(resolvedRepo, taskId);
  if (task.status === 'passed') {
    throw new Error(`Task ${taskId} has already passed. Use --force to re-run.`);
  }

  // 2. Resolve the git repo this task targets. In single-repo mode this equals
  //    resolvedRepo; in workspace mode it is the child repo declared in repos.json.
  const targetRepoPath = await resolveRepoPathForTask(resolvedRepo, task);
  if (task.repo_id) {
    console.log(`  Target repo: [${task.repo_id}] ${targetRepoPath}`);
  }

  // 3. Prepare the task working tree (the task runs directly in the target repo checkout).
  console.log(`  Preparing repo context for ${taskId}...`);
  const worktree = await createWorktree(resolvedRepo, taskId, targetRepoPath);
  console.log(`  Working path: ${worktree.worktreePath}`);

  // 4. Load config for check commands (best-effort — missing config is handled in runChecks)
  const config = await readJson(orchestratorPaths.config(resolvedRepo), ConfigSchema);

  // 4. Mark task as running
  const startedAt = new Date().toISOString();
  const runningTask: Task = { ...task, status: 'running', updated_at: startedAt };
  await updateTask(resolvedRepo, runningTask);

  // From here any unexpected throw must transition the task out of 'running'.
  try {
    // 4. Build and save the implementation brief
    const brief = buildImplementationBrief(task, worktree, opts?.fixBrief);
    const briefPath = await saveArtifact(resolvedRepo, 'prompts', taskId, 'implementation-brief.md', brief);
    console.log(`  Brief saved: ${briefPath}`);

    // 5. Invoke Claude Code CLI in the worktree
    console.log(`  Running Claude Code CLI...`);
    const claudeResult = await runCommand(
      'claude',
      [
        '--print',
        '--permission-mode',
        'bypassPermissions',
        '--add-dir',
        worktree.worktreePath,
      ],
      {
      cwd: worktree.worktreePath,
      timeoutMs: 300_000,
      input: brief,
    });

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

    // 8. Run mandatory local checks
    console.log(`  Running checks...`);
    const checks = await runChecks(
      resolvedRepo,
      taskId,
      worktree.worktreePath,
      config,
      task,
      targetRepoPath,
    );
    const completedAt = new Date().toISOString();
    const checksOk = checks.every((c) => c.ok);

    // 9. Build and persist execution result
    const attempt = task.retry_count + 1;
    const executionResult: ExecutionResult = {
      task_id: taskId,
      attempt,
      stdout: claudeResult.stdout,
      stderr: claudeResult.stderr,
      exit_code: claudeResult.exitCode,
      ok: claudeResult.ok && checksOk,
      changed_files: changedFiles,
      diff,
      checks,
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
    const nextStatus = (claudeResult.ok && checksOk) ? 'reviewing' : 'failed';
    const doneTask: Task = {
      ...runningTask,
      status: nextStatus,
      retry_count: attempt,
      updated_at: completedAt,
    };
    await updateTask(resolvedRepo, doneTask);

    const failedChecks = checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || 'none';
    await appendLog(
      resolvedRepo, taskId,
      `run-task: complete — status=${nextStatus} changed=${changedFiles.length} files exit=${claudeResult.exitCode} checks=${checks.length} failed=${failedChecks}`,
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
