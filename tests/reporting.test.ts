/**
 * Tests for the reporting layer: extractAuditResult, generateReport, runAudit.
 * runCommand is mocked so no real Codex CLI is needed.
 * Filesystem helpers (writeJson, readJson, saveArtifact) run against a real temp dir.
 */

import { jest } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readdir, readFile } from 'fs/promises';

import { writeJson, readJson } from '../src/state/persist.js';
import { orchestratorPaths } from '../src/state/paths.js';
import { ReviewResultSchema } from '../src/state/schemas.js';
import type { Task, ReviewResult } from '../src/state/schemas.js';
import type { TaskAuditInfo } from '../src/reporting/index.js';

// ─── Module mock ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/core/runner.js', () => ({
  runCommand: jest.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const repoRoot = join(tmpdir(), `orch-reporting-test-${Date.now()}`);
const NOW = new Date().toISOString();

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    status: 'passed',
    priority: 1,
    allowed_files: [],
    acceptance_criteria: ['Criterion A'],
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

function makeReview(taskId: string, overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    task_id: taskId,
    attempt: 1,
    verdict: 'PASS',
    summary: `Review for ${taskId}`,
    acceptance_checklist: [{ criterion: 'Criterion A', passed: true }],
    issues_found: [],
    fix_brief: '',
    confidence: 0.9,
    raw_output: 'PASS',
    created_at: NOW,
    ...overrides,
  };
}

function makeInfo(task: Task, review: ReviewResult | null = null): TaskAuditInfo {
  return { task, latestReview: review };
}

async function seedTaskList(tasks: Task[]) {
  await writeJson(orchestratorPaths.tasks(repoRoot), {
    version: '1',
    created_at: NOW,
    updated_at: NOW,
    tasks,
  });
}

async function seedReviewResult(taskId: string, review: ReviewResult) {
  const dir = join(orchestratorPaths.reviews(repoRoot), taskId);
  const path = join(dir, `review-result-attempt-${review.attempt}.json`);
  await writeJson(path, review);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('reporting', () => {
  let extractAuditResult: (raw: string, infos: TaskAuditInfo[]) => import('../src/reporting/index.js').AuditResultData;
  let generateReport: (repoRoot: string, auditSummary?: string) => Promise<import('../src/reporting/index.js').ReportResult>;
  let runAudit: (repoRoot: string) => Promise<import('../src/reporting/index.js').AuditResult>;
  let mockRunCommand: jest.Mock;

  beforeAll(async () => {
    const mod = await import('../src/reporting/index.js');
    extractAuditResult = mod.extractAuditResult;
    generateReport = mod.generateReport;
    runAudit = mod.runAudit;

    const runner = await import('../src/core/runner.js');
    mockRunCommand = runner.runCommand as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ─── extractAuditResult ────────────────────────────────────────────────────

  describe('extractAuditResult', () => {
    const noInfos: TaskAuditInfo[] = [];

    test('parses a JSON code block', () => {
      const raw = '```json\n{"overall":"PASS","summary":"All good.","concerns":[]}\n```';
      const result = extractAuditResult(raw, noInfos);
      expect(result.overall).toBe('PASS');
      expect(result.summary).toBe('All good.');
      expect(result.concerns).toEqual([]);
      expect(result.created_at).toBeTruthy();
    });

    test('parses a bare JSON object', () => {
      const raw = '{"overall":"FAIL","summary":"Broken.","concerns":["Missing tests"]}';
      const result = extractAuditResult(raw, noInfos);
      expect(result.overall).toBe('FAIL');
      expect(result.summary).toBe('Broken.');
      expect(result.concerns).toEqual(['Missing tests']);
    });

    test('normalises an unknown overall value to PARTIAL', () => {
      const raw = '{"overall":"UNKNOWN","summary":"Meh.","concerns":[]}';
      const result = extractAuditResult(raw, noInfos);
      expect(result.overall).toBe('PARTIAL');
    });

    test('falls back to PASS derived from task statuses when output is unparseable', () => {
      const infos = [
        makeInfo(makeTask('A', { status: 'passed' })),
        makeInfo(makeTask('B', { status: 'passed' })),
      ];
      const result = extractAuditResult('not json at all', infos);
      expect(result.overall).toBe('PASS');
      expect(result.summary).toBe('not json at all');
    });

    test('falls back to PARTIAL when some tasks are failed/blocked', () => {
      const infos = [
        makeInfo(makeTask('A', { status: 'passed' })),
        makeInfo(makeTask('B', { status: 'failed' })),
      ];
      const result = extractAuditResult('garbage', infos);
      expect(result.overall).toBe('PARTIAL');
    });

    test('falls back to FAIL when all tasks failed/blocked', () => {
      const infos = [
        makeInfo(makeTask('A', { status: 'failed' })),
        makeInfo(makeTask('B', { status: 'blocked' })),
      ];
      const result = extractAuditResult('garbage', infos);
      expect(result.overall).toBe('FAIL');
    });

    test('uses placeholder summary when raw output is empty', () => {
      const result = extractAuditResult('', noInfos);
      expect(result.summary).toBe('(no audit output)');
    });
  });

  // ─── generateReport ────────────────────────────────────────────────────────

  describe('generateReport', () => {
    test('writes final-report.json with correct counts', async () => {
      const tasks = [
        makeTask('T1', { status: 'passed' }),
        makeTask('T2', { status: 'failed' }),
        makeTask('T3', { status: 'blocked' }),
      ];
      await seedTaskList(tasks);

      const result = await generateReport(repoRoot);

      const saved = await readJson(result.reportJsonPath, (await import('../src/state/schemas.js')).FinalReportSchema);
      expect(saved?.total_tasks).toBe(3);
      expect(saved?.passed).toBe(1);
      expect(saved?.failed).toBe(1);
      expect(saved?.blocked).toBe(1);
    });

    test('reportJsonPath points to final-report.json inside reports dir', async () => {
      const tasks = [makeTask('T1')];
      await seedTaskList(tasks);

      const result = await generateReport(repoRoot);

      expect(result.reportJsonPath).toContain('final-report.json');
      expect(result.reportJsonPath).toContain('.ai-orchestrator');
    });

    test('writes a markdown file containing task sections', async () => {
      const tasks = [
        makeTask('T1', { title: 'Alpha task' }),
        makeTask('T2', { title: 'Beta task', status: 'failed' }),
      ];
      await seedTaskList(tasks);

      const result = await generateReport(repoRoot);

      const md = await readFile(result.reportPath, 'utf8');
      expect(md).toContain('# Orchestration Report');
      expect(md).toContain('T1: Alpha task');
      expect(md).toContain('T2: Beta task');
      expect(md).toContain('passed');
      expect(md).toContain('failed');
    });

    test('includes audit summary section when provided', async () => {
      await seedTaskList([makeTask('T1')]);

      const result = await generateReport(repoRoot, '**Overall: PASS**\n\nAll done.');

      const md = await readFile(result.reportPath, 'utf8');
      expect(md).toContain('## Audit');
      expect(md).toContain('All done.');
    });

    test('omits audit section when no audit summary is given', async () => {
      await seedTaskList([makeTask('T1')]);

      const result = await generateReport(repoRoot, '');

      const md = await readFile(result.reportPath, 'utf8');
      expect(md).not.toContain('## Audit');
    });

    test('loads latest review result per task and includes it in the report', async () => {
      const task = makeTask('T1', { status: 'passed' });
      await seedTaskList([task]);
      await seedReviewResult('T1', makeReview('T1', {
        verdict: 'PASS',
        summary: 'Looks great',
        issues_found: [],
        acceptance_checklist: [{ criterion: 'Works', passed: true }],
      }));

      const result = await generateReport(repoRoot);

      const md = await readFile(result.reportPath, 'utf8');
      expect(md).toContain('PASS');
      expect(md).toContain('Looks great');
      expect(md).toContain('Works');

      // task_summaries should carry the verdict
      expect(result.finalReport.task_summaries[0].verdict).toBe('PASS');
    });

    test('handles tasks with no review result gracefully', async () => {
      // Use a distinct ID so no prior seedReviewResult call in this suite affects it
      await seedTaskList([makeTask('T-noreview', { status: 'pending' })]);

      const result = await generateReport(repoRoot);

      expect(result.finalReport.task_summaries[0].verdict).toBeNull();
      const md = await readFile(result.reportPath, 'utf8');
      expect(md).toContain('n/a');
    });

    test('throws when tasks.json is missing', async () => {
      // Use a fresh path with no tasks seeded
      const emptyRepo = join(tmpdir(), `orch-empty-${Date.now()}`);
      await expect(generateReport(emptyRepo)).rejects.toThrow(/No tasks found/);
    });
  });

  // ─── runAudit ──────────────────────────────────────────────────────────────

  describe('runAudit', () => {
    const codexPassResponse = JSON.stringify({
      overall: 'PASS',
      summary: 'Everything looks good.',
      concerns: [],
    });

    test('persists normalized audit-result.json with parsed data', async () => {
      await seedTaskList([makeTask('T1')]);
      mockRunCommand.mockResolvedValue({ stdout: codexPassResponse, stderr: '', exitCode: 0, ok: true });

      const result = await runAudit(repoRoot);

      expect(result.auditResultPath).toContain('audit-result.json');

      const saved = await readJson(result.auditResultPath, {
        parse: (data: unknown) => data as import('../src/reporting/index.js').AuditResultData,
      } as never);
      // Use direct file read to avoid schema dependency
      const raw = await readFile(result.auditResultPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.overall).toBe('PASS');
      expect(parsed.summary).toBe('Everything looks good.');
      expect(parsed.created_at).toBeTruthy();
    });

    test('audit-result.json overall matches extraction from Codex output', async () => {
      await seedTaskList([makeTask('T1', { status: 'failed' })]);
      mockRunCommand.mockResolvedValue({
        stdout: '```json\n{"overall":"FAIL","summary":"Bad.","concerns":["Issue 1"]}\n```',
        stderr: '',
        exitCode: 0,
        ok: true,
      });

      const result = await runAudit(repoRoot);

      const raw = await readFile(result.auditResultPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.overall).toBe('FAIL');
      expect(parsed.concerns).toEqual(['Issue 1']);
    });

    test('saves prompt and raw output artifacts', async () => {
      await seedTaskList([makeTask('T1')]);
      mockRunCommand.mockResolvedValue({ stdout: codexPassResponse, stderr: '', exitCode: 0, ok: true });

      const result = await runAudit(repoRoot);

      expect(result.promptPath).toContain('audit-prompt.md');
      expect(result.rawOutputPath).toContain('audit-raw.md');

      const promptContent = await readFile(result.promptPath, 'utf8');
      expect(promptContent).toContain('Task Results');
    });

    test('falls back gracefully when Codex returns unparseable output', async () => {
      await seedTaskList([makeTask('T1', { status: 'passed' })]);
      mockRunCommand.mockResolvedValue({ stdout: 'garbled output', stderr: '', exitCode: 0, ok: true });

      const result = await runAudit(repoRoot);

      expect(result.overall).toBe('PASS'); // derived from task statuses
      const raw = await readFile(result.auditResultPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.overall).toBe('PASS');
    });
  });
});
