import { orchestratorPaths } from './paths.js';
import { readJson, writeJson } from './persist.js';
import { TaskListSchema, type Task } from './schemas.js';

/** Load a single task by ID. Throws if tasks.json is missing or the task is not found. */
export async function loadTask(repoRoot: string, taskId: string): Promise<Task> {
  const tasksPath = orchestratorPaths.tasks(repoRoot);
  const taskList = await readJson(tasksPath, TaskListSchema);
  if (!taskList) {
    throw new Error(`tasks.json not found at ${tasksPath} — run 'orchestrator plan' first`);
  }
  const task = taskList.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in tasks.json`);
  }
  return task;
}

/** Overwrite a single task in tasks.json, updating the list's updated_at timestamp. */
export async function updateTask(repoRoot: string, updated: Task): Promise<void> {
  const tasksPath = orchestratorPaths.tasks(repoRoot);
  const taskList = await readJson(tasksPath, TaskListSchema);
  if (!taskList) {
    throw new Error(`tasks.json not found at ${tasksPath}`);
  }
  const idx = taskList.tasks.findIndex((t) => t.id === updated.id);
  if (idx === -1) {
    throw new Error(`Task ${updated.id} not found in tasks.json`);
  }
  taskList.tasks[idx] = updated;
  taskList.updated_at = new Date().toISOString();
  await writeJson(tasksPath, taskList);
}
