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
  /** Content to write to the process's stdin. */
  input?: string;
  /** How stdin should be connected for the child process. */
  stdin?: 'pipe' | 'ignore';
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
      input: options.input,
      stdin: options.stdin,
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
