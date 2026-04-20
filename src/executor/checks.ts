import { runCommand } from '../core/runner.js';
import { saveArtifact } from '../artifacts/index.js';
import type { CheckOutput, Config, Task } from '../state/schemas.js';

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
  task?: Task,
  targetRepoPath?: string,
): Promise<CheckOutput[]> {
  if (task?.repo_id && task.test_commands.length > 0 && !config) {
    console.log('  Checks: using task test_commands (workspace fallback; config.json not found)');
    return runExplicitCommands(repoRoot, taskId, worktreePath, task.test_commands, targetRepoPath);
  }

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

async function runExplicitCommands(
  repoRoot: string,
  taskId: string,
  worktreePath: string,
  commands: string[],
  targetRepoPath?: string,
): Promise<CheckOutput[]> {
  const results: CheckOutput[] = [];
  const usedNames = new Map<string, number>();

  for (const rawCommand of commands) {
    const command = rewriteCommandForWorktree(rawCommand, targetRepoPath);
    const baseName = inferCheckName(command);
    const seen = usedNames.get(baseName) ?? 0;
    usedNames.set(baseName, seen + 1);
    const name = seen === 0 ? baseName : `${baseName}-${seen + 1}`;

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

function rewriteCommandForWorktree(command: string, targetRepoPath?: string): string {
  if (!targetRepoPath) return command;
  const escaped = escapeRegex(targetRepoPath);
  return command.replace(new RegExp(`^cd\\s+${escaped}\\s*&&\\s*`), '');
}

function inferCheckName(command: string): string {
  const lower = command.toLowerCase();
  if (/\b(eslint|lint)\b/.test(lower)) return 'lint';
  if (/\b(typecheck|tsc)\b/.test(lower)) return 'typecheck';
  if (/\b(test|jest|vitest)\b/.test(lower)) return 'test';
  if (/\bbuild\b/.test(lower)) return 'build';
  return 'check';
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatCheckArtifact(command: string, stdout: string, stderr: string, exitCode: number): string {
  const parts = [`<!-- command: ${command} | exit code: ${exitCode} -->`];
  if (stdout) parts.push(`## stdout\n\n${stdout}`);
  if (stderr) parts.push(`## stderr\n\n${stderr}`);
  if (parts.length === 1) parts.push('(no output)');
  return parts.join('\n\n');
}
