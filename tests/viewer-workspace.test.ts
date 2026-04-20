/**
 * Tests for viewer repo context.
 *
 * Covers:
 * - Overview table adds a "Repo" column when any task has `repo_id`, and each
 *   row shows the task's repo_id.
 * - Task detail page for a workspace task shows the repo_id prominently.
 * - Single-repo mode keeps the original columns with no "Repo" header.
 *
 * The render functions are invoked directly; no HTTP server is started.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';

import { writeJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { renderOverview, renderTaskDetail } from '../src/viewer/index.js';
import type { Task } from '../src/state/schemas.js';

const tmp = join(tmpdir(), `orch-viewer-ws-${Date.now()}`);
const NOW = new Date().toISOString();

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    status: 'pending',
    priority: 1,
    allowed_files: [],
    acceptance_criteria: [],
    implementation_notes: '',
    test_commands: [],
    retry_count: 0,
    max_retries: 3,
    created_at: NOW,
    updated_at: NOW,
    dependencies: [],
    ...overrides,
  };
}

async function seedTasks(root: string, tasks: Task[]) {
  await mkdir(orchestratorPaths.root(root), { recursive: true });
  await writeJson(orchestratorPaths.tasks(root), {
    version: '1', created_at: NOW, updated_at: NOW, tasks,
  });
}

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('viewer repo context', () => {
  // ─── Overview (task list) ─────────────────────────────────────────────────

  test('overview adds a Repo column when any task has repo_id and shows each id', async () => {
    const root = join(tmp, 'overview-ws');
    await seedTasks(root, [
      makeTask('A', { repo_id: 'frontend' }),
      makeTask('B', { repo_id: 'backend' }),
    ]);

    const html = await renderOverview(root);

    // Header gets the Repo column.
    expect(html).toMatch(/<th>ID<\/th>\s*<th>Repo<\/th>/);
    // Both rows list their repo.
    expect(html).toContain('>frontend<');
    expect(html).toContain('>backend<');
  });

  test('overview in single-repo mode omits the Repo column', async () => {
    const root = join(tmp, 'overview-single');
    await seedTasks(root, [makeTask('A'), makeTask('B')]);

    const html = await renderOverview(root);

    // The table header should not include a Repo column when no task carries a repo_id.
    expect(html).not.toMatch(/<th>Repo<\/th>/);
    expect(html).toMatch(/<th>ID<\/th>\s*<th>Title<\/th>/);
  });

  test('overview shows an em-dash for rows that have no repo_id when other rows do', async () => {
    const root = join(tmp, 'overview-mixed');
    await seedTasks(root, [
      makeTask('A', { repo_id: 'svc' }),
      makeTask('B'), // no repo_id
    ]);

    const html = await renderOverview(root);

    // Repo column is present (because A has a repo_id)…
    expect(html).toMatch(/<th>Repo<\/th>/);
    // …and row B renders an em-dash rather than leaving the cell empty.
    expect(html).toContain('&mdash;');
  });

  // ─── Task detail ──────────────────────────────────────────────────────────

  test('task detail for a workspace task surfaces the repo_id prominently', async () => {
    const root = join(tmp, 'detail-ws');
    await seedTasks(root, [makeTask('A', { repo_id: 'repoA' })]);

    const html = await renderTaskDetail(root, 'A');

    // A "Repo:" label with the repo id appears near the top of the detail page.
    expect(html).toMatch(/Repo:\s*<strong>repoA<\/strong>/);
  });

  test('task detail for a single-repo task does not render a Repo line', async () => {
    const root = join(tmp, 'detail-single');
    await seedTasks(root, [makeTask('A')]);

    const html = await renderTaskDetail(root, 'A');

    expect(html).not.toMatch(/Repo:\s*<strong>/);
  });

  test('task detail for a missing task returns a not-found page (no crash)', async () => {
    const root = join(tmp, 'detail-missing');
    await seedTasks(root, [makeTask('A')]);

    const html = await renderTaskDetail(root, 'Z');

    expect(html).toContain('not found');
  });
});
