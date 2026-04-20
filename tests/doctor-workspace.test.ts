import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir, writeFile } from 'fs/promises';
import { jest } from '@jest/globals';
import { runCommand } from '../src/core/runner.js';
import { runDoctor, runDoctorWorkspace } from '../src/core/doctor.js';

const tmp = join(tmpdir(), `orch-doctor-ws-test-${Date.now()}`);

// Suppress console output during tests
beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await mkdir(tmp, { recursive: true });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeGitRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await runCommand('git', ['-C', dir, 'init']);
  await runCommand('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await runCommand('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), '# test\n');
  await runCommand('git', ['-C', dir, 'add', '-A']);
  await runCommand('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

async function makeWorkspace(wsDir: string, repos: Array<{ id: string; path: string }>): Promise<void> {
  await mkdir(join(wsDir, '.ai-orchestrator'), { recursive: true });
  await writeFile(
    join(wsDir, '.ai-orchestrator', 'repos.json'),
    JSON.stringify({ version: '1', repos: repos.map((r) => ({ ...r, description: '' })) }),
  );
}

// ─── Single-repo mode ─────────────────────────────────────────────────────────
// runDoctor return value only — tool availability on PATH is not asserted.

describe('doctor single-repo mode', () => {
  test('returns false for a non-git directory regardless of tool availability', async () => {
    const dir = join(tmp, 'not-a-repo');
    await mkdir(dir, { recursive: true });
    const ok = await runDoctor(dir);
    expect(ok).toBe(false);
  });
});

// ─── Workspace repo checks (isolated from tool PATH checks) ──────────────────
// Use runDoctorWorkspace directly so tool checks (codex/claude) cannot affect counts.

describe('runDoctorWorkspace — all repos valid', () => {
  test('returns 0 when all declared repos are valid git repos', async () => {
    const ws = join(tmp, 'ws-all-valid');
    const repo1 = await makeGitRepo(join(ws, 'repo1'));
    const repo2 = await makeGitRepo(join(ws, 'repo2'));
    await makeWorkspace(ws, [
      { id: 'r1', path: repo1 },
      { id: 'r2', path: repo2 },
    ]);

    const failedCount = await runDoctorWorkspace(ws);
    expect(failedCount).toBe(0);
  });
});

describe('runDoctorWorkspace — mixed valid/invalid repos', () => {
  test('returns exact count of failed repos and prints correct summary line', async () => {
    const ws = join(tmp, 'ws-mixed');
    const goodRepo = await makeGitRepo(join(ws, 'good'));
    await makeWorkspace(ws, [
      { id: 'good', path: goodRepo },
      { id: 'bad1', path: join(ws, 'missing1') },
      { id: 'bad2', path: join(ws, 'missing2') },
    ]);

    (console.log as jest.Mock).mockClear();
    const failedCount = await runDoctorWorkspace(ws);

    expect(failedCount).toBe(2);

    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toMatch(/2 repo\(s\) missing/);
  });

  test('runDoctor returns false when workspace has invalid repos', async () => {
    const ws = join(tmp, 'ws-mixed-full');
    const goodRepo = await makeGitRepo(join(ws, 'good'));
    await makeWorkspace(ws, [
      { id: 'good', path: goodRepo },
      { id: 'bad', path: join(ws, 'missing') },
    ]);

    const ok = await runDoctor(ws);
    expect(ok).toBe(false);
  });
});

describe('runDoctorWorkspace — malformed manifest', () => {
  test('returns 1 when repos.json is not valid JSON', async () => {
    const ws = join(tmp, 'ws-malformed');
    await mkdir(join(ws, '.ai-orchestrator'), { recursive: true });
    await writeFile(join(ws, '.ai-orchestrator', 'repos.json'), '{ bad json }');

    const failedCount = await runDoctorWorkspace(ws);
    expect(failedCount).toBe(1);
  });
});

describe('runDoctorWorkspace — empty repos list', () => {
  test('returns 0 and prints warning when repos array is empty', async () => {
    const ws = join(tmp, 'ws-empty');
    await makeWorkspace(ws, []);

    (console.log as jest.Mock).mockClear();
    const failedCount = await runDoctorWorkspace(ws);

    expect(failedCount).toBe(0);
    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toMatch(/no repos declared/);
  });
});
