import { runCommand } from '../core/runner.js';
import { saveArtifact } from '../artifacts/index.js';
import type { CheckOutput, Config } from '../state/schemas.js';

const MANDATORY_CHECKS = ['lint', 'test', 'typecheck'] as const;
type CheckName = typeof MANDATORY_CHECKS[number];

const COMMAND_KEY: Record<CheckName, keyof Pick<Config, 'lint_command' | 'test_command' | 'typecheck_command'>> = {
  lint: 'lint_command',
  test: 'test_command',
  typecheck: 'typecheck_command',
};

/**
 * Run all three mandatory checks (lint, test, typecheck) in the task worktree.
 * A missing config or blank command produces a failed CheckOutput rather than a silent skip,
 * so that the absence of configuration is visible in the execution result.
 */
export async function runChecks(
  repoRoot: string,
  taskId: string,
  worktreePath: string,
  config: Config | null,
): Promise<CheckOutput[]> {
  if (!config) {
    console.log('  Checks failed: config.json not found — run orchestrator plan first');
    return MANDATORY_CHECKS.map((name) => ({
      name,
      command: '',
      stdout: '',
      stderr: 'config.json not found — run orchestrator plan first',
      exit_code: -1,
      ok: false,
    }));
  }

  const results: CheckOutput[] = [];

  for (const name of MANDATORY_CHECKS) {
    const command = config[COMMAND_KEY[name]];

    if (!command.trim()) {
      console.log(`  Check [${name}]: FAILED — ${name}_command is blank in config.json`);
      results.push({
        name,
        command: '',
        stdout: '',
        stderr: `${name}_command is blank in config.json`,
        exit_code: -1,
        ok: false,
      });
      continue;
    }

    console.log(`  Check [${name}]: ${command}`);
    const result = await runCommand('sh', ['-c', command], {
      cwd: worktreePath,
      timeoutMs: 120_000,
    });

    const icon = result.ok ? '✓' : '✗';
    console.log(`    ${icon} exit ${result.exitCode}`);

    await saveArtifact(
      repoRoot, 'artifacts', taskId,
      `check-${name}.txt`,
      formatCheckArtifact(command, result.stdout, result.stderr, result.exitCode),
    );

    results.push({
      name,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      ok: result.ok,
    });
  }

  return results;
}

function formatCheckArtifact(command: string, stdout: string, stderr: string, exitCode: number): string {
  const parts = [`<!-- command: ${command} | exit code: ${exitCode} -->`];
  if (stdout) parts.push(`## stdout\n\n${stdout}`);
  if (stderr) parts.push(`## stderr\n\n${stderr}`);
  if (parts.length === 1) parts.push('(no output)');
  return parts.join('\n\n');
}
