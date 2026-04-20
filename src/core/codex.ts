import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCommand, type RunResult } from './runner.js';

const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL?.trim() || 'gpt-5.4-mini';

export async function runCodexPrompt(
  prompt: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'orch-codex-'));
  const outputPath = join(tempDir, 'last-message.txt');

  try {
    const result = await runCommand(
      'codex',
      ['exec', '--skip-git-repo-check', '--model', DEFAULT_CODEX_MODEL, '-o', outputPath, prompt],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        stdin: 'ignore',
      },
    );

    let stdout = result.stdout;
    try {
      const fileOutput = await readFile(outputPath, 'utf8');
      if (fileOutput.trim()) {
        stdout = fileOutput;
      }
    } catch {
      // Fallback to captured stdout for tests/mocks or older CLI behavior.
    }

    return { ...result, stdout };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
