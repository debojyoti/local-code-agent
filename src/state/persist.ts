import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { z } from 'zod';

/**
 * Read and validate a JSON file. Returns null if the file does not exist.
 * Throws on parse errors or schema validation failures.
 * Using ZodTypeAny + z.output<S> ensures callers get the OUTPUT type
 * (with defaults applied) rather than the input type.
 */
export async function readJson<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
): Promise<z.output<S> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return schema.parse(parsed) as z.output<S>;
}

/**
 * Write data as formatted JSON, creating parent directories as needed.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOENT';
}
