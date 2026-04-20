import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { z } from 'zod';

/**
 * Read and validate a JSON file. Returns null if the file does not exist.
 * Throws on parse errors or schema validation failures.
 */
export async function readJson<T>(
  filePath: string,
  schema: z.ZodSchema<T>,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return schema.parse(parsed);
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
