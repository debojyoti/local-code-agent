import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir, writeFile } from 'fs/promises';
import {
  isWorkspaceRoot,
  readWorkspaceManifest,
  writeWorkspaceManifest,
  resolveRepoPath,
  resolveTaskRepoPath,
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

// ─── resolveTaskRepoPath ──────────────────────────────────────────────────────

describe('resolveTaskRepoPath', () => {
  const manifest = WorkspaceManifestSchema.parse({
    repos: [
      { id: 'frontend', path: './frontend', description: '' },
      { id: 'backend', path: '/abs/backend', description: '' },
    ],
  });

  test('returns workspaceRoot when task has no repo_id and no manifest (single-repo mode)', () => {
    expect(resolveTaskRepoPath('/workspace', {})).toBe('/workspace');
    expect(resolveTaskRepoPath('/workspace', { repo_id: undefined })).toBe('/workspace');
  });

  test('throws when task has no repo_id but a manifest is present', () => {
    expect(() => resolveTaskRepoPath('/workspace', {}, manifest))
      .toThrow(/no repo_id.*workspace manifest is present/);
    expect(() => resolveTaskRepoPath('/workspace', { repo_id: undefined }, manifest))
      .toThrow(/no repo_id.*workspace manifest is present/);
  });

  test('resolves relative repo path from manifest', () => {
    expect(resolveTaskRepoPath('/workspace', { repo_id: 'frontend' }, manifest))
      .toBe('/workspace/frontend');
  });

  test('resolves absolute repo path from manifest', () => {
    expect(resolveTaskRepoPath('/workspace', { repo_id: 'backend' }, manifest))
      .toBe('/abs/backend');
  });

  test('throws when repo_id is set but no manifest provided', () => {
    expect(() => resolveTaskRepoPath('/workspace', { repo_id: 'frontend' }))
      .toThrow(/no workspace manifest/);
  });

  test('throws when repo_id is not found in manifest', () => {
    expect(() => resolveTaskRepoPath('/workspace', { repo_id: 'unknown' }, manifest))
      .toThrow(/not found in workspace manifest/);
  });
});
