import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readFile, writeFile } from 'fs/promises';
import { parseRepoEntries, initWorkspaceScaffold } from '../src/workspace/init.js';
import { readWorkspaceManifest } from '../src/workspace/index.js';
import { orchestratorPaths } from '../src/state/paths.js';

const tmp = join(tmpdir(), `orch-init-ws-${Date.now()}`);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('parseRepoEntries', () => {
  test('parses comma-separated repo entries', () => {
    const repos = parseRepoEntries('frontend=./frontend, backend=./backend');
    expect(repos).toEqual([
      { id: 'frontend', path: './frontend', description: '' },
      { id: 'backend', path: './backend', description: '' },
    ]);
  });

  test('rejects invalid repo entry syntax', () => {
    expect(() => parseRepoEntries('frontend')).toThrow(/id=path/);
  });

  test('rejects duplicate repo ids', () => {
    expect(() => parseRepoEntries('frontend=./a,frontend=./b')).toThrow(/Duplicate repo id/);
  });
});

describe('initWorkspaceScaffold', () => {
  test('writes repos.json, spec.md, and base directories', async () => {
    const root = join(tmp, 'basic');
    const result = await initWorkspaceScaffold(root, [
      { id: 'frontend', path: './frontend', description: '' },
      { id: 'backend', path: './backend', description: '' },
    ]);

    const manifest = await readWorkspaceManifest(root);
    expect(manifest.repos.map((r) => r.id)).toEqual(['frontend', 'backend']);

    const spec = await readFile(result.specPath, 'utf8');
    expect(spec).toContain('Workspace Spec');
    expect(spec).toContain('`frontend`');
    expect(spec).toContain('`backend`');
    expect(spec).toContain('Definition of done');

    await expect(readFile(orchestratorPaths.repos(root), 'utf8')).resolves.toContain('"frontend"');
    await expect(readFile(orchestratorPaths.spec(root), 'utf8')).resolves.toContain('Goals:');
  });

  test('refuses to overwrite existing scaffold files without force', async () => {
    const root = join(tmp, 'no-overwrite');
    await initWorkspaceScaffold(root, [{ id: 'frontend', path: './frontend', description: '' }]);

    await expect(
      initWorkspaceScaffold(root, [{ id: 'backend', path: './backend', description: '' }]),
    ).rejects.toThrow(/already exists/);
  });

  test('overwrites existing scaffold files with force', async () => {
    const root = join(tmp, 'force-overwrite');
    await initWorkspaceScaffold(root, [{ id: 'frontend', path: './frontend', description: '' }]);
    await writeFile(orchestratorPaths.spec(root), 'old spec', 'utf8');

    await initWorkspaceScaffold(root, [{ id: 'backend', path: './backend', description: '' }], true);

    const manifest = await readWorkspaceManifest(root);
    expect(manifest.repos.map((r) => r.id)).toEqual(['backend']);
    await expect(readFile(orchestratorPaths.spec(root), 'utf8')).resolves.not.toContain('old spec');
  });
});
