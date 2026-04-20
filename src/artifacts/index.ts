import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { orchestratorPaths } from '../state/paths.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ArtifactCategory = 'prompts' | 'artifacts' | 'reviews' | 'reports' | 'logs';

// ─── Timestamp ───────────────────────────────────────────────────────────────

let _seq = 0;

/**
 * Collision-resistant filename timestamp: 20240420T123456789-0001
 * Milliseconds + a per-process sequence counter guarantee uniqueness
 * even when multiple artifacts are written within the same millisecond.
 */
export function artifactTimestamp(): string {
  const ms = new Date()
    .toISOString()
    .replace(/-/g, '')
    .replace(/:/g, '')
    .replace('.', '')
    .slice(0, 18); // YYYYMMDDTHHmmssSSS
  const seq = String(++_seq).padStart(4, '0');
  return `${ms}-${seq}`;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

function categoryDir(repoRoot: string, category: ArtifactCategory): string {
  switch (category) {
    case 'prompts':   return orchestratorPaths.prompts(repoRoot);
    case 'artifacts': return orchestratorPaths.artifacts(repoRoot);
    case 'reviews':   return orchestratorPaths.reviews(repoRoot);
    case 'reports':   return orchestratorPaths.reports(repoRoot);
    case 'logs':      return orchestratorPaths.logs(repoRoot);
  }
}

function artifactDir(
  repoRoot: string,
  category: ArtifactCategory,
  taskId: string | null,
): string {
  const base = categoryDir(repoRoot, category);
  return taskId ? join(base, taskId) : base;
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Write a text artifact and return its full path.
 *
 * Filename pattern: <timestamp>-<name>
 * Caller includes the file extension in `name` (e.g. 'planning-prompt.md').
 *
 * With taskId:    .ai-orchestrator/<category>/<taskId>/<timestamp>-<name>
 * Without taskId: .ai-orchestrator/<category>/<timestamp>-<name>
 */
export async function saveArtifact(
  repoRoot: string,
  category: ArtifactCategory,
  taskId: string | null,
  name: string,
  content: string,
): Promise<string> {
  const dir = artifactDir(repoRoot, category, taskId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${artifactTimestamp()}-${name}`);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** Read a text artifact by path. Returns null if the file does not exist. */
export async function readArtifact(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as { code?: string })?.code === 'ENOENT') return null;
    throw err;
  }
}

// ─── Log ─────────────────────────────────────────────────────────────────────

/**
 * Append a timestamped line to a task log or the global orchestrator log.
 *
 * Task log:   .ai-orchestrator/logs/<taskId>.log
 * Global log: .ai-orchestrator/logs/orchestrator.log
 */
export async function appendLog(
  repoRoot: string,
  taskId: string | null,
  message: string,
): Promise<void> {
  const dir = orchestratorPaths.logs(repoRoot);
  await mkdir(dir, { recursive: true });
  const filename = taskId ? `${taskId}.log` : 'orchestrator.log';
  const filePath = join(dir, filename);
  await appendFile(filePath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}
