import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir, writeFile, readFile } from 'fs/promises';
import { execa } from 'execa';

const tmp = join(tmpdir(), `orch-planner-ws-${Date.now()}`);

// ─── Controlled Codex response ────────────────────────────────────────────────

const codexResult = { stdout: '', stderr: '', exitCode: 0 };

function setCodexResponse(stdout: string, exitCode = 0): void {
  codexResult.stdout = stdout;
  codexResult.stderr = '';
  codexResult.exitCode = exitCode;
}

// ─── Mock runner ─────────────────────────────────────────────────────────────
// Codex calls return the controlled response; git and all other commands pass
// through to real execa so inspectWorkspace and repo setup work correctly.

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(async (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ) => {
    if (cmd === 'codex') {
      return {
        stdout: codexResult.stdout,
        stderr: codexResult.stderr,
        exitCode: codexResult.exitCode,
        ok: codexResult.exitCode === 0,
      };
    }
    try {
      const result = await execa(cmd, args, {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs ?? 30_000,
        reject: false,
      });
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 1,
        ok: result.exitCode === 0,
      };
    } catch (err) {
      return { stdout: '', stderr: String(err), exitCode: 127, ok: false };
    }
  }),
}));

// ─── Dynamic imports (after mock registration) ────────────────────────────────

let runPlan: typeof import('../src/planner/index.js').runPlan;
let inspectWorkspace: typeof import('../src/planner/inspect.js').inspectWorkspace;

beforeAll(async () => {
  ({ runPlan } = await import('../src/planner/index.js'));
  ({ inspectWorkspace } = await import('../src/planner/inspect.js'));
  await mkdir(tmp, { recursive: true });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(async () => {
  jest.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execa('git', ['-C', dir, 'init']);
  await execa('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), '# test');
  await execa('git', ['-C', dir, 'add', '-A']);
  await execa('git', ['-C', dir, 'commit', '-m', 'init']);
}

async function makeWorkspace(
  wsDir: string,
  repos: Array<{ id: string; path: string }>,
): Promise<string> {
  await mkdir(join(wsDir, '.ai-orchestrator'), { recursive: true });
  await writeFile(
    join(wsDir, '.ai-orchestrator', 'repos.json'),
    JSON.stringify({ version: '1', repos: repos.map((r) => ({ ...r, description: '' })) }),
  );
  const specPath = join(wsDir, 'spec.md');
  await writeFile(specPath, '# Spec\nDo the thing.');
  return specPath;
}

function workspacePlanJson(repoId: string, includeRepoId = true) {
  return JSON.stringify({
    repo_summary: 'test workspace',
    assumptions: [],
    tasks: [
      {
        id: 'TASK-001',
        ...(includeRepoId ? { repo_id: repoId } : {}),
        title: 'Setup',
        goal: 'Init the repo',
        priority: 1,
        allowed_files: [],
        acceptance_criteria: [],
        test_commands: [],
        dependencies: [],
      },
    ],
    recommended_commands: {},
    risks: [],
  });
}

// ─── inspectWorkspace — repo validation (fix 1) ───────────────────────────────

describe('inspectWorkspace repo validation', () => {
  test('throws when a declared repo path does not exist', async () => {
    const ws = join(tmp, 'bad-path-ws');
    await mkdir(ws, { recursive: true });
    const manifest = {
      version: '1' as const,
      repos: [{ id: 'missing', path: join(ws, 'nowhere'), description: '' }],
    };
    await expect(inspectWorkspace(ws, manifest))
      .rejects.toThrow(/not a git repository|validation failed/i);
  });

  test('throws when a declared repo is a plain directory (not git)', async () => {
    const ws = join(tmp, 'plain-dir-ws');
    const plainDir = join(ws, 'plain');
    await mkdir(plainDir, { recursive: true });
    const manifest = {
      version: '1' as const,
      repos: [{ id: 'plain', path: plainDir, description: '' }],
    };
    await expect(inspectWorkspace(ws, manifest))
      .rejects.toThrow(/not a git repository|validation failed/i);
  });

  test('error message names all bad repos, not just the first', async () => {
    const ws = join(tmp, 'multi-bad-ws');
    await mkdir(ws, { recursive: true });
    const manifest = {
      version: '1' as const,
      repos: [
        { id: 'bad1', path: join(ws, 'missing1'), description: '' },
        { id: 'bad2', path: join(ws, 'missing2'), description: '' },
      ],
    };
    let err: Error | undefined;
    try { await inspectWorkspace(ws, manifest); } catch (e) { err = e as Error; }
    expect(err?.message).toContain('bad1');
    expect(err?.message).toContain('bad2');
  });

  test('succeeds and returns context when all repos are valid git repos', async () => {
    const ws = join(tmp, 'valid-ws');
    const r1 = join(ws, 'repo1');
    await makeGitRepo(r1);
    const manifest = {
      version: '1' as const,
      repos: [{ id: 'repo1', path: r1, description: '' }],
    };
    const ctx = await inspectWorkspace(ws, manifest);
    expect(ctx.repos).toHaveLength(1);
    expect(ctx.repos[0].repoId).toBe('repo1');
    expect(ctx.repos[0].repoPath).toBe(r1);
  });
});

// ─── runPlan — workspace mode ─────────────────────────────────────────────────

describe('runPlan workspace mode', () => {
  test('fails before Codex when a workspace repo is invalid', async () => {
    const ws = join(tmp, 'plan-bad-ws');
    const specPath = await makeWorkspace(ws, [{ id: 'bad', path: './nowhere' }]);
    // Error must come from repo validation, not "Codex CLI failed"
    await expect(runPlan(ws, specPath))
      .rejects.toThrow(/not a git repository|validation failed/i);
  });

  test('uses workspace planning prompt when workspace is detected', async () => {
    const ws = join(tmp, 'plan-prompt-ws');
    const r1 = join(ws, 'repoA');
    await makeGitRepo(r1);
    const specPath = await makeWorkspace(ws, [{ id: 'repoA', path: r1 }]);
    setCodexResponse(workspacePlanJson('repoA'));

    const result = await runPlan(ws, specPath);
    const savedPrompt = await readFile(result.promptArtifactPath, 'utf8');

    expect(savedPrompt).toContain('multi-repo workspace');
    expect(savedPrompt).toContain('repo_id');
    expect(savedPrompt).toContain('repoA');
  });

  test('persists tasks with repo_id into tasks.json', async () => {
    const ws = join(tmp, 'plan-persist-ws');
    const r1 = join(ws, 'repo1');
    await makeGitRepo(r1);
    const specPath = await makeWorkspace(ws, [{ id: 'repo1', path: r1 }]);
    setCodexResponse(workspacePlanJson('repo1'));

    const result = await runPlan(ws, specPath);

    expect(result.tasks[0].repo_id).toBe('repo1');
    const raw = JSON.parse(await readFile(result.tasksPath, 'utf8'));
    expect(raw.tasks[0].repo_id).toBe('repo1');
  });

  test('fails clearly when Codex output omits repo_id on workspace tasks', async () => {
    const ws = join(tmp, 'plan-missing-id-ws');
    const r1 = join(ws, 'repo1');
    await makeGitRepo(r1);
    const specPath = await makeWorkspace(ws, [{ id: 'repo1', path: r1 }]);
    setCodexResponse(workspacePlanJson('repo1', /* includeRepoId= */ false));

    await expect(runPlan(ws, specPath)).rejects.toThrow(/missing repo_id/);
  });
});
