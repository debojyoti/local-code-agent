import { execa } from 'execa';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export async function runCommand(
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  try {
    const result = await execa(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30_000,
      reject: false,
      all: false,
    });

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 1,
      ok: result.exitCode === 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: message,
      exitCode: 127,
      ok: false,
    };
  }
}
