import { resolve } from 'path';
import { runCommand } from './runner.js';
import { isWorkspaceRoot, readWorkspaceManifest, resolveRepoPath } from '../workspace/index.js';

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
    label: `git repository: ${repoPath}`,
    ok: result.ok,
    detail: result.ok
      ? result.stdout.trim()
      : `${repoPath} is not inside a git repository`,
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

async function runDoctorSingleRepo(resolvedPath: string): Promise<boolean> {
  const repoCheck = await checkRepo(resolvedPath);

  console.log('\nRepository:');
  printCheck(repoCheck);

  return repoCheck.ok;
}

/** Returns the number of failed repo checks (0 = all ok). Exported for testing. */
export async function runDoctorWorkspace(workspaceRoot: string): Promise<number> {
  let manifest;
  try {
    manifest = await readWorkspaceManifest(workspaceRoot);
  } catch (err) {
    console.log('\nWorkspace:');
    console.log(`  ✗  [FAIL] cannot read .ai-orchestrator/repos.json`);
    console.log(`       → ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(`\nWorkspace root: ${workspaceRoot}`);
  console.log(`Repos declared: ${manifest.repos.length}\n`);

  if (manifest.repos.length === 0) {
    console.log('  ⚠  [warn] no repos declared in repos.json');
    return 0;
  }

  const repoChecks: CheckResult[] = await Promise.all(
    manifest.repos.map(async (entry) => {
      const absPath = resolveRepoPath(workspaceRoot, entry);
      const check = await checkRepo(absPath);
      return {
        ...check,
        label: `[${entry.id}] ${absPath}${entry.description ? ` — ${entry.description}` : ''}`,
      };
    }),
  );

  console.log('Repos:');
  for (const check of repoChecks) {
    printCheck(check);
  }

  const failedCount = repoChecks.filter((c) => !c.ok).length;
  if (failedCount > 0) {
    console.log(`\n  ${failedCount} repo(s) missing or not a git repository.`);
  }

  return failedCount;
}

export async function runDoctor(repoPath?: string): Promise<boolean> {
  const resolvedPath = resolve(repoPath ?? process.cwd());

  console.log('\nOrchestrator Doctor\n' + '─'.repeat(40));

  const toolChecks: CheckResult[] = await Promise.all([
    checkCli('codex'),
    checkCli('claude'),
    checkGitCli(),
  ]);

  console.log('\nTool checks:');
  for (const check of toolChecks) printCheck(check);

  const workspace = await isWorkspaceRoot(resolvedPath);

  let repoFailures: number;
  if (workspace) {
    repoFailures = await runDoctorWorkspace(resolvedPath);
  } else {
    const ok = await runDoctorSingleRepo(resolvedPath);
    repoFailures = ok ? 0 : 1;
  }

  const toolFailures = toolChecks.filter((c) => !c.ok && c.critical).length;
  const totalFailures = toolFailures + repoFailures;

  console.log('');
  if (totalFailures === 0) {
    console.log('All checks passed. Ready to orchestrate.\n');
  } else {
    console.log(`${totalFailures} critical check(s) failed. Fix the issues above before proceeding.\n`);
  }

  return totalFailures === 0;
}
