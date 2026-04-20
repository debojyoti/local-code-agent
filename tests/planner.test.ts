import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readFile } from 'fs/promises';
import { extractPlanningOutput, normalizeTasks, validateWorkspaceTaskRepoIds } from '../src/planner/extract.js';
import { buildPlanningPrompt, buildWorkspacePlanningPrompt } from '../src/planner/prompt.js';
import { formatRawOutput } from '../src/planner/index.js';
import { readJson } from '../src/state/persist.js';
import { ConfigSchema } from '../src/state/schemas.js';
import { orchestratorPaths } from '../src/state/paths.js';
import type { RepoContext, WorkspaceContext } from '../src/planner/inspect.js';

// ─── extractPlanningOutput ────────────────────────────────────────────────────

const validTaskJson = {
  id: 'TASK-001',
  title: 'Add auth',
  goal: 'Implement JWT authentication',
  priority: 1,
  allowed_files: ['src/auth.ts'],
  acceptance_criteria: ['tokens are validated'],
  implementation_notes: '',
  test_commands: ['npm test'],
  dependencies: [],
};

const validPlanJson = {
  repo_summary: 'A test repo',
  assumptions: ['Node 20+'],
  tasks: [validTaskJson],
  recommended_commands: { lint: 'npm run lint', test: 'npm test', typecheck: 'npm run typecheck' },
  risks: ['tight deadline'],
};

describe('extractPlanningOutput', () => {
  test('parses a clean JSON string', () => {
    const output = extractPlanningOutput(JSON.stringify(validPlanJson));
    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0].id).toBe('TASK-001');
  });

  test('extracts JSON from a ```json code block', () => {
    const wrapped = `Here is your plan:\n\`\`\`json\n${JSON.stringify(validPlanJson)}\n\`\`\`\nDone.`;
    const output = extractPlanningOutput(wrapped);
    expect(output.repo_summary).toBe('A test repo');
  });

  test('applies defaults for optional fields', () => {
    const minimal = { tasks: [{ id: 'T-1', title: 'x', goal: 'y', priority: 1 }] };
    const output = extractPlanningOutput(JSON.stringify(minimal));
    expect(output.assumptions).toEqual([]);
    expect(output.risks).toEqual([]);
    expect(output.tasks[0].allowed_files).toEqual([]);
  });

  test('throws on non-JSON output', () => {
    expect(() => extractPlanningOutput('Sorry, I cannot help with that.')).toThrow();
  });

  test('throws on JSON that does not match schema (missing tasks)', () => {
    expect(() => extractPlanningOutput(JSON.stringify({ repo_summary: 'hi' }))).toThrow();
  });

  test('uses ```json block over trailing JSON when both present', () => {
    const block = `\`\`\`json\n${JSON.stringify(validPlanJson)}\n\`\`\`\n{ "tasks": [] }`;
    const output = extractPlanningOutput(block);
    expect(output.tasks).toHaveLength(1);
  });
});

// ─── normalizeTasks ───────────────────────────────────────────────────────────

describe('normalizeTasks', () => {
  test('adds status, retry fields, and timestamps', () => {
    const output = extractPlanningOutput(JSON.stringify(validPlanJson));
    const tasks = normalizeTasks(output);

    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].retry_count).toBe(0);
    expect(tasks[0].max_retries).toBe(3);
    expect(tasks[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(tasks[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('preserves task fields from Codex output', () => {
    const output = extractPlanningOutput(JSON.stringify(validPlanJson));
    const tasks = normalizeTasks(output);

    expect(tasks[0].id).toBe('TASK-001');
    expect(tasks[0].title).toBe('Add auth');
    expect(tasks[0].allowed_files).toEqual(['src/auth.ts']);
  });

  test('produces one Task per raw task', () => {
    const multi = {
      ...validPlanJson,
      tasks: [
        validTaskJson,
        { ...validTaskJson, id: 'TASK-002', title: 'Add tests', priority: 2, dependencies: ['TASK-001'] },
      ],
    };
    const output = extractPlanningOutput(JSON.stringify(multi));
    const tasks = normalizeTasks(output);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].dependencies).toEqual(['TASK-001']);
  });
});

// ─── buildPlanningPrompt ──────────────────────────────────────────────────────

describe('buildPlanningPrompt', () => {
  const ctx: RepoContext = {
    repoPath: '/tmp/test-repo',
    gitLog: 'abc1234 initial commit',
    topLevelItems: ['src', 'package.json', 'README.md'],
    packageJson: '{"name": "test"}',
    readme: '# Test Repo',
  };

  test('includes the spec content', () => {
    const prompt = buildPlanningPrompt('## My Spec\nDo the thing.', ctx);
    expect(prompt).toContain('## My Spec');
    expect(prompt).toContain('Do the thing.');
  });

  test('includes repo path and git log', () => {
    const prompt = buildPlanningPrompt('spec', ctx);
    expect(prompt).toContain('/tmp/test-repo');
    expect(prompt).toContain('abc1234 initial commit');
  });

  test('includes top-level items', () => {
    const prompt = buildPlanningPrompt('spec', ctx);
    expect(prompt).toContain('src');
    expect(prompt).toContain('package.json');
  });

  test('includes package.json when present', () => {
    const prompt = buildPlanningPrompt('spec', ctx);
    expect(prompt).toContain('"name": "test"');
  });

  test('omits package.json section when null', () => {
    const prompt = buildPlanningPrompt('spec', { ...ctx, packageJson: null });
    expect(prompt).not.toContain('package.json\n```');
  });

  test('requests a ```json code block in the response', () => {
    const prompt = buildPlanningPrompt('spec', ctx);
    expect(prompt).toContain('```json');
  });
});

// ─── buildWorkspacePlanningPrompt ─────────────────────────────────────────────

describe('buildWorkspacePlanningPrompt', () => {
  const wsCtx: WorkspaceContext = {
    workspaceRoot: '/tmp/workspace',
    repos: [
      {
        repoId: 'frontend',
        repoPath: '/tmp/workspace/frontend',
        gitLog: 'abc1234 initial commit',
        topLevelItems: ['src', 'package.json'],
        packageJson: '{"name": "frontend"}',
        readme: '# Frontend',
      },
      {
        repoId: 'backend',
        repoPath: '/tmp/workspace/backend',
        gitLog: 'def5678 add api',
        topLevelItems: ['src', 'go.mod'],
        packageJson: null,
        readme: null,
      },
    ],
  };

  test('includes workspace root and repo ids', () => {
    const prompt = buildWorkspacePlanningPrompt('## Spec\nDo it.', wsCtx);
    expect(prompt).toContain('/tmp/workspace');
    expect(prompt).toContain('frontend');
    expect(prompt).toContain('backend');
  });

  test('includes per-repo path and git log', () => {
    const prompt = buildWorkspacePlanningPrompt('spec', wsCtx);
    expect(prompt).toContain('/tmp/workspace/frontend');
    expect(prompt).toContain('abc1234 initial commit');
    expect(prompt).toContain('/tmp/workspace/backend');
    expect(prompt).toContain('def5678 add api');
  });

  test('labels each repo section with repo_id', () => {
    const prompt = buildWorkspacePlanningPrompt('spec', wsCtx);
    expect(prompt).toContain('repo_id: "frontend"');
    expect(prompt).toContain('repo_id: "backend"');
  });

  test('includes the spec content', () => {
    const prompt = buildWorkspacePlanningPrompt('## My Spec\nDo the thing.', wsCtx);
    expect(prompt).toContain('## My Spec');
    expect(prompt).toContain('Do the thing.');
  });

  test('includes package.json for repos that have it', () => {
    const prompt = buildWorkspacePlanningPrompt('spec', wsCtx);
    expect(prompt).toContain('"name": "frontend"');
  });

  test('omits package.json section for repos without it', () => {
    const prompt = buildWorkspacePlanningPrompt('spec', wsCtx);
    // backend has no packageJson — its section should not contain a json block for it
    const backendSection = prompt.split('## Repository: backend')[1] ?? '';
    const frontendSection = prompt.split('## Repository: backend')[0] ?? '';
    expect(frontendSection).toContain('```json');      // frontend has it
    // backend section has no package.json block (next repo section or end of prompt)
    const backendUpToNextSection = backendSection.split('## Specification')[0] ?? '';
    expect(backendUpToNextSection).not.toContain('"name":');
  });

  test('instructs Codex that repo_id is required and lists valid values', () => {
    const prompt = buildWorkspacePlanningPrompt('spec', wsCtx);
    expect(prompt).toMatch(/repo_id.*required|Every task MUST include a repo_id/i);
    expect(prompt).toContain('"frontend"');
    expect(prompt).toContain('"backend"');
  });

  test('requests a ```json code block in the response', () => {
    const prompt = buildWorkspacePlanningPrompt('spec', wsCtx);
    expect(prompt).toContain('```json');
  });
});

// ─── validateWorkspaceTaskRepoIds ─────────────────────────────────────────────

describe('validateWorkspaceTaskRepoIds', () => {
  const now = new Date().toISOString();

  function makeTask(id: string, repo_id?: string) {
    return {
      id,
      title: 'T',
      goal: 'G',
      status: 'pending' as const,
      priority: 1,
      allowed_files: [],
      acceptance_criteria: [],
      implementation_notes: '',
      test_commands: [],
      retry_count: 0,
      max_retries: 3,
      created_at: now,
      updated_at: now,
      dependencies: [],
      repo_id,
    };
  }

  test('passes when all tasks have valid repo_ids', () => {
    const tasks = [makeTask('T-1', 'frontend'), makeTask('T-2', 'backend')];
    expect(() => validateWorkspaceTaskRepoIds(tasks, ['frontend', 'backend'])).not.toThrow();
  });

  test('throws when a task is missing repo_id', () => {
    const tasks = [makeTask('T-1', 'frontend'), makeTask('T-2', undefined)];
    expect(() => validateWorkspaceTaskRepoIds(tasks, ['frontend', 'backend']))
      .toThrow(/T-2.*missing repo_id/);
  });

  test('throws when a task has an unknown repo_id', () => {
    const tasks = [makeTask('T-1', 'unknown-repo')];
    expect(() => validateWorkspaceTaskRepoIds(tasks, ['frontend', 'backend']))
      .toThrow(/unknown-repo/);
  });

  test('passes for an empty task list', () => {
    expect(() => validateWorkspaceTaskRepoIds([], ['frontend'])).not.toThrow();
  });
});

// ─── normalizeTasks preserves repo_id ─────────────────────────────────────────

describe('normalizeTasks with repo_id', () => {
  test('passes repo_id through to normalized tasks', () => {
    const planJson = {
      tasks: [{ id: 'T-1', title: 'x', goal: 'y', priority: 1, repo_id: 'backend' }],
    };
    const output = extractPlanningOutput(JSON.stringify(planJson));
    const tasks = normalizeTasks(output);
    expect(tasks[0].repo_id).toBe('backend');
  });

  test('leaves repo_id undefined when absent (single-repo compat)', () => {
    const planJson = {
      tasks: [{ id: 'T-1', title: 'x', goal: 'y', priority: 1 }],
    };
    const output = extractPlanningOutput(JSON.stringify(planJson));
    const tasks = normalizeTasks(output);
    expect(tasks[0].repo_id).toBeUndefined();
  });
});

// ─── formatRawOutput ──────────────────────────────────────────────────────────

describe('formatRawOutput', () => {
  test('includes exit code header', () => {
    const out = formatRawOutput('hello', '', 0);
    expect(out).toContain('exit code: 0');
  });

  test('includes stdout section when stdout is present', () => {
    const out = formatRawOutput('my output', '', 0);
    expect(out).toContain('## stdout');
    expect(out).toContain('my output');
  });

  test('includes stderr section when stderr is present', () => {
    const out = formatRawOutput('', 'an error', 1);
    expect(out).toContain('## stderr');
    expect(out).toContain('an error');
  });

  test('includes both stdout and stderr when both present', () => {
    const out = formatRawOutput('out', 'err', 0);
    expect(out).toContain('## stdout');
    expect(out).toContain('## stderr');
  });

  test('shows (no output) when both are empty', () => {
    const out = formatRawOutput('', '', 0);
    expect(out).toContain('(no output)');
  });
});

// ─── config.json persistence after plan ──────────────────────────────────────

describe('config.json inferred commands', () => {
  const repoRoot = join(tmpdir(), `orch-config-test-${Date.now()}`);

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test('writeJson + readJson preserves inferred commands in config shape', async () => {
    const { writeJson } = await import('../src/state/persist.js');
    const configPath = orchestratorPaths.config(repoRoot);

    const config = ConfigSchema.parse({
      repo_path: repoRoot,
      spec_path: `${repoRoot}/.ai-orchestrator/spec.md`,
      lint_command: 'npm run lint',
      test_command: 'npm test',
      typecheck_command: 'npm run typecheck',
    });

    await writeJson(configPath, config);
    const loaded = await readJson(configPath, ConfigSchema);

    expect(loaded?.lint_command).toBe('npm run lint');
    expect(loaded?.test_command).toBe('npm test');
    expect(loaded?.typecheck_command).toBe('npm run typecheck');
    expect(loaded?.repo_path).toBe(repoRoot);
  });

  test('existing non-empty commands are not overwritten by empty inferred values', () => {
    const existing = ConfigSchema.parse({ repo_path: '/r', lint_command: 'eslint .' });
    const cmds = { lint: '', test: 'npm test', typecheck: '' };
    const updated = {
      ...existing,
      lint_command: existing.lint_command || cmds.lint || '',
      test_command: existing.test_command || cmds.test || '',
      typecheck_command: existing.typecheck_command || cmds.typecheck || '',
    };
    expect(updated.lint_command).toBe('eslint .');   // preserved
    expect(updated.test_command).toBe('npm test');   // filled in
    expect(updated.typecheck_command).toBe('');       // neither had a value
  });
});
