import { resolve } from 'path';
import { readJson, writeJson } from '../state/persist.js';
import { orchestratorPaths } from '../state/paths.js';
import { TaskListSchema, ConfigSchema, StateSchema, type Task, type State } from '../state/schemas.js';
import { updateTask } from '../state/tasks.js';
import { runTaskLoop } from '../executor/loop.js';
import { appendLog } from '../artifacts/index.js';

export interface OrchestrationResult {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

// Topological sort respecting dependencies. Preserves original order for independent tasks.
// Throws on circular dependencies or references to unknown task IDs.
function topoSort(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const result: Task[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  // Validate all dependency references up front so the error is immediate.
  for (const task of tasks) {
    const missing = task.dependencies.filter((d) => !byId.has(d));
    if (missing.length > 0) {
      throw new Error(
        `Task ${task.id} references unknown dependency ID(s): ${missing.join(', ')}`,
      );
    }
  }

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular dependency detected involving task ${id}`);
    }
    const task = byId.get(id)!;
    visiting.add(id);
    for (const dep of task.dependencies) visit(dep);
    visiting.delete(id);
    visited.add(id);
    result.push(task);
  }

  for (const task of tasks) visit(task.id);
  return result;
}

function allDepsPassed(task: Task, taskMap: Map<string, Task>): boolean {
  return task.dependencies.every((depId) => taskMap.get(depId)?.status === 'passed');
}

/** Prefix the task id/title with `[repo_id]` when the task targets a specific repo. */
function taskLabel(task: Task): string {
  const repoTag = task.repo_id ? `[${task.repo_id}] ` : '';
  return `${repoTag}${task.id}  ${task.title}`;
}

function now(): string {
  return new Date().toISOString();
}

async function saveState(repoRoot: string, state: State): Promise<void> {
  await writeJson(orchestratorPaths.state(repoRoot), state);
}

export async function runOrchestration(repoRoot: string, resume: boolean): Promise<OrchestrationResult> {
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, null, `orchestrator: ${resume ? 'resume' : 'run'} started`);

  // Load config
  const config = await readJson(orchestratorPaths.config(resolvedRepo), ConfigSchema).catch(() => null);
  const stopOnBlocked = config?.stop_on_blocked ?? true;

  // Load or initialize orchestrator state
  let state: State;
  if (resume) {
    const existing = await readJson(orchestratorPaths.state(resolvedRepo), StateSchema);
    if (!existing) {
      throw new Error(`state.json not found — nothing to resume. Run 'orchestrator run' first.`);
    }
    state = { ...existing, status: 'running', updated_at: now() };
    console.log(`  Resuming. Last status: ${existing.status}, last task: ${existing.current_task_id ?? 'none'}`);
  } else {
    state = {
      version: '1',
      status: 'running',
      current_task_id: null,
      started_at: now(),
      updated_at: now(),
    };
  }
  await saveState(resolvedRepo, state);

  // Load tasks
  const taskList = await readJson(orchestratorPaths.tasks(resolvedRepo), TaskListSchema);
  if (!taskList || taskList.tasks.length === 0) {
    throw new Error(`tasks.json not found or empty — run 'orchestrator plan' first`);
  }

  // On resume: reset tasks stuck mid-execution to pending so they re-run cleanly
  if (resume) {
    for (const task of taskList.tasks) {
      if (task.status === 'running' || task.status === 'reviewing') {
        console.log(`  Resetting stuck task ${taskLabel(task)} (was '${task.status}') → pending`);
        await appendLog(resolvedRepo, task.id, `orchestrator: reset '${task.status}' → pending on resume`);
        await updateTask(resolvedRepo, { ...task, status: 'pending', updated_at: now() });
      }
    }
    // Reload after resets
    const refreshed = await readJson(orchestratorPaths.tasks(resolvedRepo), TaskListSchema);
    if (refreshed) taskList.tasks.splice(0, taskList.tasks.length, ...refreshed.tasks);
  }

  // Sort into dependency order and build mutable map for tracking status
  const ordered = topoSort(taskList.tasks);
  const taskMap = new Map<string, Task>(ordered.map((t) => [t.id, t]));

  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let skipped = 0;

  // Pre-count already-passed tasks
  for (const task of ordered) {
    if (task.status === 'passed') passed++;
  }

  const SEP = '─'.repeat(50);

  for (const task of ordered) {
    const current = taskMap.get(task.id)!;

    if (current.status === 'passed') {
      console.log(`\n  [skip]  ${taskLabel(current)}  (already passed)`);
      continue;
    }

    if (current.status === 'blocked' || current.status === 'failed') {
      console.log(`\n  [skip]  ${taskLabel(current)}  (${current.status})`);
      skipped++;
      continue;
    }

    if (!allDepsPassed(current, taskMap)) {
      const unmet = current.dependencies.filter((d) => taskMap.get(d)?.status !== 'passed');
      console.log(`\n  [skip]  ${taskLabel(current)}  (unmet deps: ${unmet.join(', ')})`);
      await appendLog(resolvedRepo, current.id, `orchestrator: skipping — unmet deps: ${unmet.join(', ')}`);
      skipped++;
      continue;
    }

    console.log(`\n${SEP}`);
    console.log(`  Task ${taskLabel(current)}`);
    console.log(SEP);

    state = { ...state, current_task_id: current.id, updated_at: now() };
    await saveState(resolvedRepo, state);
    await appendLog(resolvedRepo, current.id, `orchestrator: starting task`);

    let result;
    try {
      result = await runTaskLoop(resolvedRepo, current.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Task ${current.id} threw: ${msg}`);
      await appendLog(resolvedRepo, current.id, `orchestrator: task threw — ${msg}`);
      failed++;
      state = { ...state, updated_at: now() };
      await saveState(resolvedRepo, state);
      console.log(`  Stopping: unrecoverable failure in task ${current.id}`);
      break;
    }

    // Keep taskMap current for downstream dependency checks
    taskMap.set(result.task.id, result.task);

    console.log(`  Result: ${result.stoppedReason}  (${result.attempts.length} attempt(s))`);
    await appendLog(resolvedRepo, current.id, `orchestrator: task stopped — ${result.stoppedReason}`);

    if (result.stoppedReason === 'pass') {
      passed++;
    } else if (result.stoppedReason === 'blocked') {
      blocked++;
      state = { ...state, updated_at: now() };
      await saveState(resolvedRepo, state);
      if (stopOnBlocked) {
        console.log(`\n  Stopping: task ${taskLabel(current)} is BLOCKED (stop_on_blocked=true)`);
        await appendLog(resolvedRepo, null, `orchestrator: stopping on blocked task ${current.id}`);
        break;
      }
    } else {
      failed++;
      state = { ...state, updated_at: now() };
      await saveState(resolvedRepo, state);
      console.log(`\n  Stopping: task ${taskLabel(current)} failed (reason: ${result.stoppedReason})`);
      await appendLog(resolvedRepo, null, `orchestrator: stopping on failed task ${current.id}`);
      break;
    }

    state = { ...state, updated_at: now() };
    await saveState(resolvedRepo, state);
  }

  const finalStatus: State['status'] = failed > 0 || blocked > 0 ? 'failed' : 'complete';
  state = { ...state, status: finalStatus, current_task_id: null, updated_at: now() };
  await saveState(resolvedRepo, state);
  await appendLog(
    resolvedRepo,
    null,
    `orchestrator: finished — passed=${passed} failed=${failed} blocked=${blocked} skipped=${skipped}`,
  );

  return { total: ordered.length, passed, failed, blocked, skipped };
}
