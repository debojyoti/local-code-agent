import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir, writeFile } from 'fs/promises';
import {
  isWorkspaceRoot,
  readWorkspaceManifest,
  writeWorkspaceManifest,
  resolveRepoPath,
  WorkspaceManifestSchema,
} from '../src/workspace/index.js';

const tmp = join(tmpdir(), `orch-workspace-test-${Date.now()}`);

beforeAll(async () => {
  await mkdir(tmp, { recursive: true });
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ─── isWorkspaceRoot ─────────────────────────────────────────────────────────

describe('isWorkspaceRoot', () => {
  test('returns false when no repos.json exists', async () => {
    const dir = join(tmp, 'not-a-workspace');
    await mkdir(dir, { recursive: true });
    await expect(isWorkspaceRoot(dir)).resolves.toBe(false);
  });

  test('returns true when .ai-orchestrator/repos.json exists', async () => {
    const dir = join(tmp, 'has-manifest');
    await mkdir(join(dir, '.ai-orchestrator'), { recursive: true });
    await writeFile(
      join(dir, '.ai-orchestrator', 'repos.json'),
      JSON.stringify({ version: '1', repos: [] }),
    );
    await expect(isWorkspaceRoot(dir)).resolves.toBe(true);
  });
});

// ─── readWorkspaceManifest / writeWorkspaceManifest ──────────────────────────

describe('readWorkspaceManifest', () => {
  test('round-trips a valid manifest', async () => {
    const dir = join(tmp, 'roundtrip');
    const manifest = WorkspaceManifestSchema.parse({
      repos: [
        { id: 'frontend', path: './frontend', description: 'UI layer' },
        { id: 'backend', path: '/abs/backend', description: '' },
      ],
    });

    await writeWorkspaceManifest(dir, manifest);
    const read = await readWorkspaceManifest(dir);

    expect(read.repos).toHaveLength(2);
    expect(read.repos[0].id).toBe('frontend');
    expect(read.repos[1].path).toBe('/abs/backend');
  });

  test('throws on missing file', async () => {
    const dir = join(tmp, 'no-dir');
    await expect(readWorkspaceManifest(dir)).rejects.toThrow();
  });

  test('throws on malformed JSON', async () => {
    const dir = join(tmp, 'bad-json');
    await mkdir(join(dir, '.ai-orchestrator'), { recursive: true });
    await writeFile(join(dir, '.ai-orchestrator', 'repos.json'), '{ not json }');
    await expect(readWorkspaceManifest(dir)).rejects.toThrow(SyntaxError);
  });

  test('throws on invalid schema (missing id)', async () => {
    const dir = join(tmp, 'bad-schema');
    await mkdir(join(dir, '.ai-orchestrator'), { recursive: true });
    await writeFile(
      join(dir, '.ai-orchestrator', 'repos.json'),
      JSON.stringify({ version: '1', repos: [{ path: './foo' }] }),
    );
    await expect(readWorkspaceManifest(dir)).rejects.toThrow();
  });
});

// ─── resolveRepoPath ─────────────────────────────────────────────────────────

describe('resolveRepoPath', () => {
  test('returns absolute path unchanged', () => {
    const entry = { id: 'x', path: '/absolute/path', description: '' };
    expect(resolveRepoPath('/workspace', entry)).toBe('/absolute/path');
  });

  test('resolves relative path against workspace root', () => {
    const entry = { id: 'x', path: './child', description: '' };
    expect(resolveRepoPath('/workspace', entry)).toBe('/workspace/child');
  });

  test('resolves dotdot path against workspace root', () => {
    const entry = { id: 'x', path: '../sibling', description: '' };
    expect(resolveRepoPath('/workspace/sub', entry)).toBe('/workspace/sibling');
  });
});
