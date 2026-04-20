/**
 * Tests for the plan-refine module.
 * runCommand is mocked so no real Codex CLI is needed.
 * State helpers use a real temp directory.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readFile } from 'fs/promises';

import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { ConfigSchema, TaskListSchema } from '../src/state/schemas.js';
import type { Task } from '../src/state/schemas.js';

// ─── Module mock ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const repoRoot = join(tmpdir(), `orch-refine-test-${Date.now()}`);
const NOW = new Date().toISOString();

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    status: 'pending',
    priority: 1,
    allowed_files: [],
    acceptance_criteria: ['Works'],
    implementation_notes: '',
    test_commands: ['npm test'],
    retry_count: 0,
    max_retries: 3,
    created_at: NOW,
    updated_at: NOW,
    dependencies: [],
    ...overrides,
  };
}

function makePlanJson(
  tasks: Array<{ id: string; title: string; goal?: string }> = [{ id: 'TASK-001', title: 'Alpha' }],
  recommendedCommands: { lint?: string; test?: string; typecheck?: string } = { lint: '', test: 'npm test', typecheck: '' },
) {
  return JSON.stringify({
    repo_summary: 'Test repo',
    assumptions: [],
    tasks: tasks.map((t, i) => ({
      id: t.id,
      title: t.title,
      goal: t.goal ?? `Goal of ${t.id}`,
      priority: i + 1,
      allowed_files: [],
      acceptance_criteria: ['It works'],
      implementation_notes: '',
      test_commands: [],
      dependencies: [],
    })),
    recommended_commands: recommendedCommands,
    risks: [],
  });
}

async function seedTaskList(tasks: Task[]) {
  await writeJson(orchestratorPaths.tasks(repoRoot), {
    version: '1',
    created_at: NOW,
    updated_at: NOW,
    tasks,
  });
}

async function seedSpec(content = '## Spec\nDo the thing.') {
  await writeJson(orchestratorPaths.spec(repoRoot), content);
  // Use writeFile instead since spec is plain text, not JSON
  const { writeFile, mkdir } = await import('fs/promises');
  await mkdir(orchestratorPaths.root(repoRoot), { recursive: true });
  await writeFile(orchestratorPaths.spec(repoRoot), content, 'utf8');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('runPlanRefine', () => {
  let runPlanRefine: (repoRoot: string, opts: { feedback: string }) => Promise<import('../src/planner/refine.js').RefineResult>;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    const mod = await import('../src/planner/refine.js');
    runPlanRefine = mod.runPlanRefine;

    const runner = await import('../src/core/runner.js');
    mockRunCommand = runner.runCommand as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ─── Failure cases ─────────────────────────────────────────────────────────

  test('throws clearly when feedback is empty string', async () => {
    await seedTaskList([makeTask('T1')]);
    await expect(runPlanRefine(repoRoot, { feedback: '' }))
      .rejects.toThrow(/feedback/i);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  test('throws clearly when feedback is only whitespace', async () => {
    await seedTaskList([makeTask('T1')]);
    await expect(runPlanRefine(repoRoot, { feedback: '   \n  ' }))
      .rejects.toThrow(/feedback/i);
  });

  test('throws clearly when tasks.json is missing', async () => {
    // Use a fresh repo path with no tasks.json
    const emptyRepo = join(tmpdir(), `orch-refine-empty-${Date.now()}`);
    await expect(runPlanRefine(emptyRepo, { feedback: 'add logging' }))
      .rejects.toThrow(/run.*plan/i);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  test('calls Codex with a prompt and returns refined tasks', async () => {
    await seedTaskList([makeTask('TASK-001')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'TASK-001', title: 'Alpha' }, { id: 'TASK-002', title: 'Beta' }]),
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'add a logging task' });

    expect(mockRunCommand).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((t) => t.id)).toContain('TASK-001');
    expect(result.tasks.map((t) => t.id)).toContain('TASK-002');
  });

  test('overwrites tasks.json with refined tasks', async () => {
    await seedTaskList([makeTask('TASK-001')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'TASK-NEW', title: 'New Task' }]),
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'change everything' });

    const saved = await readJson(result.tasksPath, TaskListSchema);
    expect(saved?.tasks).toHaveLength(1);
    expect(saved?.tasks[0].id).toBe('TASK-NEW');
  });

  test('preserves original created_at in tasks.json', async () => {
    const originalCreatedAt = '2024-01-01T00:00:00.000Z';
    await writeJson(orchestratorPaths.tasks(repoRoot), {
      version: '1',
      created_at: originalCreatedAt,
      updated_at: NOW,
      tasks: [makeTask('T1')],
    });
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'T1', title: 'Same' }]),
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'minor tweak' });

    const saved = await readJson(result.tasksPath, TaskListSchema);
    expect(saved?.created_at).toBe(originalCreatedAt);
  });

  test('correctly classifies added, removed, and kept tasks', async () => {
    await seedTaskList([makeTask('TASK-A'), makeTask('TASK-B')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([
        { id: 'TASK-A', title: 'Kept' },
        { id: 'TASK-C', title: 'Added' },
      ]),
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'replace B with C' });

    expect(result.kept).toEqual(['TASK-A']);
    expect(result.added).toEqual(['TASK-C']);
    expect(result.removed).toEqual(['TASK-B']);
  });

  test('saves prompt and raw output as artifacts', async () => {
    await seedTaskList([makeTask('T1')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson(),
      stderr: '',
      exitCode: 0,
      ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'improve things' });

    expect(result.promptArtifactPath).toContain('refine-prompt.md');
    expect(result.rawOutputArtifactPath).toContain('refine-output.md');

    const promptContent = await readFile(result.promptArtifactPath, 'utf8');
    expect(promptContent).toContain('User Feedback');
    expect(promptContent).toContain('improve things');
  });

  test('throws when Codex exits non-zero', async () => {
    await seedTaskList([makeTask('T1')]);
    mockRunCommand.mockResolvedValue({
      stdout: '',
      stderr: 'quota exceeded',
      exitCode: 1,
      ok: false,
    });

    await expect(runPlanRefine(repoRoot, { feedback: 'do something' }))
      .rejects.toThrow(/Codex CLI failed/);
  });
});

// ─── mergeTaskState ───────────────────────────────────────────────────────────

describe('mergeTaskState', () => {
  let mergeTaskState: (fresh: Task, prior: Task) => Task;

  beforeAll(async () => {
    const mod = await import('../src/planner/refine.js');
    mergeTaskState = mod.mergeTaskState;
  });

  function fresh(overrides: Partial<Task> = {}): Task {
    return makeTask('T1', { status: 'pending', retry_count: 0, ...overrides });
  }

  function prior(overrides: Partial<Task> = {}): Task {
    return makeTask('T1', {
      status: 'passed',
      retry_count: 2,
      max_retries: 5,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-06-01T00:00:00.000Z',
      ...overrides,
    });
  }

  // ── Unchanged task: all execution state preserved ──────────────────────────

  test('unchanged task preserves passed status from prior', () => {
    const result = mergeTaskState(fresh(), prior({ status: 'passed' }));
    expect(result.status).toBe('passed');
  });

  test('unchanged task preserves retry_count from prior', () => {
    const result = mergeTaskState(fresh(), prior({ retry_count: 3 }));
    expect(result.retry_count).toBe(3);
  });

  test('unchanged task preserves max_retries from prior', () => {
    const result = mergeTaskState(fresh(), prior({ max_retries: 5 }));
    expect(result.max_retries).toBe(5);
  });

  test('unchanged task preserves created_at from prior', () => {
    const result = mergeTaskState(fresh(), prior());
    expect(result.created_at).toBe('2024-01-01T00:00:00.000Z');
  });

  test('unchanged task preserves prior updated_at', () => {
    const f = fresh({ title: 'Same', goal: 'Same goal' });
    const p = prior({ title: 'Same', goal: 'Same goal', updated_at: '2024-06-01T00:00:00.000Z' });
    const result = mergeTaskState(f, p);
    expect(result.updated_at).toBe('2024-06-01T00:00:00.000Z');
  });

  // ── Changed task: resets to pending regardless of prior status ──────────────

  test('changed title resets passed task back to pending', () => {
    const f = fresh({ title: 'New title' });
    const p = prior({ title: 'Old title', status: 'passed' });
    const result = mergeTaskState(f, p);
    expect(result.status).toBe('pending');
    expect(result.retry_count).toBe(0);
  });

  test('changed goal resets passed task back to pending', () => {
    const f = fresh({ goal: 'New goal' });
    const p = prior({ goal: 'Old goal', status: 'passed' });
    const result = mergeTaskState(f, p);
    expect(result.status).toBe('pending');
    expect(result.retry_count).toBe(0);
  });

  test('changed dependencies reset the task to pending', () => {
    const f = fresh({ dependencies: ['DEP-001'] });
    const p = prior({ dependencies: [], status: 'passed', retry_count: 2 });
    const result = mergeTaskState(f, p);
    expect(result.status).toBe('pending');
    expect(result.retry_count).toBe(0);
  });

  test('changed test_commands reset the task to pending', () => {
    const f = fresh({ test_commands: ['vitest run'] });
    const p = prior({ test_commands: ['npm test'], status: 'passed', retry_count: 1 });
    const result = mergeTaskState(f, p);
    expect(result.status).toBe('pending');
    expect(result.retry_count).toBe(0);
  });

  test('changed task still inherits max_retries and created_at from prior', () => {
    const f = fresh({ title: 'Changed title' });
    const p = prior({ title: 'Old title', max_retries: 7, created_at: '2024-01-01T00:00:00.000Z' });
    const result = mergeTaskState(f, p);
    expect(result.max_retries).toBe(7);
    expect(result.created_at).toBe('2024-01-01T00:00:00.000Z');
  });

  test('changed task refreshes updated_at', () => {
    const f = fresh({ title: 'New title' });
    const p = prior({ title: 'Old title', updated_at: '2024-06-01T00:00:00.000Z' });
    const result = mergeTaskState(f, p);
    expect(result.updated_at).not.toBe('2024-06-01T00:00:00.000Z');
  });

  test('keeps fresh content fields from Codex output', () => {
    // priority/dependencies/allowed_files come from fresh regardless of change detection
    const f = fresh({ priority: 2, dependencies: ['OTHER'], allowed_files: ['new.ts'] });
    const result = mergeTaskState(f, prior());
    expect(result.priority).toBe(2);
    expect(result.dependencies).toEqual(['OTHER']);
    expect(result.allowed_files).toEqual(['new.ts']);
  });
});

// ─── execution state preservation in runPlanRefine ────────────────────────────

describe('runPlanRefine — execution state preservation', () => {
  let runPlanRefine: (repoRoot: string, opts: { feedback: string }) => Promise<import('../src/planner/refine.js').RefineResult>;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    const mod = await import('../src/planner/refine.js');
    runPlanRefine = mod.runPlanRefine;
    const runner = await import('../src/core/runner.js');
    mockRunCommand = runner.runCommand as jest.Mock;
  });

  afterEach(() => jest.clearAllMocks());

  test('kept task retains its prior status', async () => {
    // Seed with content matching what makePlanJson produces so mergeTaskState sees no change
    await seedTaskList([makeTask('TASK-A', {
      status: 'passed',
      retry_count: 1,
      title: 'Alpha',
      goal: 'Goal of TASK-A',
      acceptance_criteria: ['It works'],
      test_commands: [],
    })]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'TASK-A', title: 'Alpha' }]),
      stderr: '', exitCode: 0, ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'minor change' });
    expect(result.tasks.find((t) => t.id === 'TASK-A')?.status).toBe('passed');
  });

  test('kept task retains its retry_count', async () => {
    // Seed with content matching what makePlanJson produces so mergeTaskState sees no change
    await seedTaskList([makeTask('TASK-A', {
      retry_count: 2,
      title: 'Alpha',
      goal: 'Goal of TASK-A',
      acceptance_criteria: ['It works'],
      test_commands: [],
    })]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'TASK-A', title: 'Alpha' }]),
      stderr: '', exitCode: 0, ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'tweak' });
    expect(result.tasks.find((t) => t.id === 'TASK-A')?.retry_count).toBe(2);
  });

  test('changed task resets from passed to pending', async () => {
    await seedTaskList([makeTask('TASK-A', { status: 'passed', retry_count: 1 })]);
    // Codex returns different title — triggers reset
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'TASK-A', title: 'Revised Alpha' }]),
      stderr: '', exitCode: 0, ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'revise task' });
    const task = result.tasks.find((t) => t.id === 'TASK-A');
    expect(task?.status).toBe('pending');
    expect(task?.retry_count).toBe(0);
  });

  test('new task gets default status=pending and retry_count=0', async () => {
    await seedTaskList([makeTask('TASK-A')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'TASK-A', title: 'Alpha' }, { id: 'TASK-NEW', title: 'Brand new' }]),
      stderr: '', exitCode: 0, ok: true,
    });

    const result = await runPlanRefine(repoRoot, { feedback: 'add a task' });
    const newTask = result.tasks.find((t) => t.id === 'TASK-NEW');
    expect(newTask?.status).toBe('pending');
    expect(newTask?.retry_count).toBe(0);
  });
});

// ─── config.json persistence in runPlanRefine ─────────────────────────────────

describe('runPlanRefine — config.json persistence', () => {
  let runPlanRefine: (repoRoot: string, opts: { feedback: string }) => Promise<import('../src/planner/refine.js').RefineResult>;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    const mod = await import('../src/planner/refine.js');
    runPlanRefine = mod.runPlanRefine;
    const runner = await import('../src/core/runner.js');
    mockRunCommand = runner.runCommand as jest.Mock;
  });

  beforeEach(async () => {
    const { unlink } = await import('fs/promises');
    await unlink(orchestratorPaths.config(repoRoot)).catch(() => {/* ok if absent */});
  });

  afterEach(async () => {
    jest.clearAllMocks();
    const { unlink } = await import('fs/promises');
    await unlink(orchestratorPaths.config(repoRoot)).catch(() => {/* ok if absent */});
  });

  test('writes config.json with recommended_commands from refined output', async () => {
    await seedTaskList([makeTask('T1')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'T1', title: 'Alpha' }], { lint: 'eslint .', test: 'vitest', typecheck: 'tsc' }),
      stderr: '', exitCode: 0, ok: true,
    });

    await runPlanRefine(repoRoot, { feedback: 'refine it' });

    const config = await readJson(orchestratorPaths.config(repoRoot), ConfigSchema);
    expect(config?.lint_command).toBe('eslint .');
    expect(config?.test_command).toBe('vitest');
    expect(config?.typecheck_command).toBe('tsc');
  });

  test('does not overwrite existing non-empty lint_command', async () => {
    await seedTaskList([makeTask('T1')]);
    await writeJson(orchestratorPaths.config(repoRoot), ConfigSchema.parse({
      repo_path: repoRoot,
      lint_command: 'my-linter',
      test_command: '',
      typecheck_command: '',
    }));
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'T1', title: 'Alpha' }], { lint: 'eslint .', test: 'vitest', typecheck: 'tsc' }),
      stderr: '', exitCode: 0, ok: true,
    });

    await runPlanRefine(repoRoot, { feedback: 'tweak' });

    const config = await readJson(orchestratorPaths.config(repoRoot), ConfigSchema);
    expect(config?.lint_command).toBe('my-linter');  // preserved
    expect(config?.test_command).toBe('vitest');      // filled in
  });

  test('config.json is written even when recommended_commands are empty strings', async () => {
    await seedTaskList([makeTask('T1')]);
    mockRunCommand.mockResolvedValue({
      stdout: makePlanJson([{ id: 'T1', title: 'Alpha' }], { lint: '', test: '', typecheck: '' }),
      stderr: '', exitCode: 0, ok: true,
    });

    await runPlanRefine(repoRoot, { feedback: 'no commands' });

    const config = await readJson(orchestratorPaths.config(repoRoot), ConfigSchema);
    expect(config).not.toBeNull();
    expect(config?.repo_path).toBe(repoRoot);
  });
});

// ─── buildRefinementPrompt ────────────────────────────────────────────────────

describe('buildRefinementPrompt', () => {
  let buildRefinementPrompt: (
    spec: string,
    tasks: Task[],
    priorOutput: string | null,
    feedback: string,
  ) => string;

  beforeAll(async () => {
    const mod = await import('../src/planner/refine.js');
    buildRefinementPrompt = mod.buildRefinementPrompt;
  });

  test('includes the spec content', () => {
    const prompt = buildRefinementPrompt('## My Spec\nDo this.', [], null, 'add tests');
    expect(prompt).toContain('## My Spec');
    expect(prompt).toContain('Do this.');
  });

  test('includes the feedback', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'add a logging module');
    expect(prompt).toContain('add a logging module');
  });

  test('includes current task IDs and titles', () => {
    const tasks = [makeTask('TASK-001', { title: 'Auth' }), makeTask('TASK-002', { title: 'DB' })];
    const prompt = buildRefinementPrompt('spec', tasks, null, 'feedback');
    expect(prompt).toContain('TASK-001');
    expect(prompt).toContain('TASK-002');
    expect(prompt).toContain('Auth');
    expect(prompt).toContain('DB');
  });

  test('includes prior output when provided', () => {
    const prompt = buildRefinementPrompt('spec', [], 'prior codex output here', 'feedback');
    expect(prompt).toContain('prior codex output here');
    expect(prompt).toContain('Prior Planning Context');
  });

  test('omits prior planning context section when prior output is null', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'feedback');
    expect(prompt).not.toContain('Prior Planning Context');
  });

  test('truncates prior output longer than 2000 chars', () => {
    const longOutput = 'x'.repeat(3000);
    const prompt = buildRefinementPrompt('spec', [], longOutput, 'feedback');
    expect(prompt).toContain('(truncated)');
    expect(prompt).not.toContain('x'.repeat(2001));
  });

  test('instructs Codex to preserve what is still good', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'feedback');
    expect(prompt).toContain('Preserve');
  });

  test('instructs Codex to keep tasks small and grounded', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'feedback');
    expect(prompt).toContain('grounded');
  });

  test('instructs Codex to preserve task IDs for unchanged tasks', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'feedback');
    expect(prompt).toContain('Preserve task IDs');
  });

  test('requests a ```json code block response', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'feedback');
    expect(prompt).toContain('```json');
  });

  test('includes User Feedback section header', () => {
    const prompt = buildRefinementPrompt('spec', [], null, 'my feedback');
    expect(prompt).toContain('## User Feedback');
    expect(prompt).toContain('my feedback');
  });
});

// ─── extraction + normalization of refined output ─────────────────────────────

describe('extraction and normalization of refined Codex output', () => {
  test('extractPlanningOutput handles refined output the same as initial output', async () => {
    const { extractPlanningOutput, normalizeTasks } = await import('../src/planner/extract.js');

    const refinedJson = makePlanJson([
      { id: 'TASK-001', title: 'Original task, kept' },
      { id: 'TASK-003', title: 'New task added by refinement' },
    ]);

    const planningOutput = extractPlanningOutput(refinedJson);
    expect(planningOutput.tasks).toHaveLength(2);
    expect(planningOutput.tasks[0].id).toBe('TASK-001');
    expect(planningOutput.tasks[1].id).toBe('TASK-003');

    const tasks = normalizeTasks(planningOutput);
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].retry_count).toBe(0);
    expect(tasks[1].status).toBe('pending');
  });

  test('extractPlanningOutput handles refined output wrapped in a ```json block', async () => {
    const { extractPlanningOutput } = await import('../src/planner/extract.js');

    const wrapped = `Here is the refined plan:\n\`\`\`json\n${makePlanJson()}\n\`\`\`\nDone.`;
    const output = extractPlanningOutput(wrapped);
    expect(output.tasks).toHaveLength(1);
  });
});
