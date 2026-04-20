import { resolve } from 'path';
import { runCommand } from './runner.js';

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}

async function checkCli(name: string): Promise<CheckResult> {
  const result = await runCommand('which', [name]);
  return {
    label: `${name} CLI on PATH`,
    ok: result.ok,
    detail: result.ok ? result.stdout.trim() : `'${name}' not found — install it and ensure it is on PATH`,
    critical: true,
  };
}

async function checkGitCli(): Promise<CheckResult> {
  const result = await runCommand('git', ['--version']);
  return {
    label: 'git CLI on PATH',
    ok: result.ok,
    detail: result.ok ? result.stdout.trim() : "git not found — install git",
    critical: true,
  };
}

async function checkRepo(repoPath: string): Promise<CheckResult> {
  const result = await runCommand('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']);
  return {
    label: 'target path is a git repository',
    ok: result.ok,
    detail: result.ok
      ? result.stdout.trim()
      : `${repoPath} is not inside a git repository — run inside a git repo or pass --repo <path>`,
    critical: true,
  };
}

function printCheck(check: CheckResult): void {
  const icon = check.ok ? '✓' : '✗';
  const status = check.ok ? 'ok' : check.critical ? 'FAIL' : 'warn';
  console.log(`  ${icon}  [${status}] ${check.label}`);
  if (!check.ok) {
    console.log(`       → ${check.detail}`);
  }
}

export async function runDoctor(repoPath?: string): Promise<boolean> {
  const resolvedRepo = resolve(repoPath ?? process.cwd());

  console.log('\nOrchestrator Doctor\n' + '─'.repeat(40));

  const checks: CheckResult[] = await Promise.all([
    checkCli('codex'),
    checkCli('claude'),
    checkGitCli(),
    checkRepo(resolvedRepo),
  ]);

  console.log('\nTool checks:');
  for (const check of checks.slice(0, 3)) printCheck(check);

  console.log('\nRepository:');
  printCheck(checks[3]);

  const failed = checks.filter((c) => !c.ok && c.critical);
  console.log('');

  if (failed.length === 0) {
    console.log('All checks passed. Ready to orchestrate.\n');
    return true;
  } else {
    console.log(`${failed.length} critical check(s) failed. Fix the issues above before proceeding.\n`);
    return false;
  }
}
