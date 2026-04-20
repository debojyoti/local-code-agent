import { resolve, join } from 'path';
import { readdir } from 'fs/promises';
import { runCommand } from '../core/runner.js';
import { orchestratorPaths } from '../state/paths.js';
import { readJson, writeJson } from '../state/persist.js';
import { TaskListSchema, ReviewResultSchema, FinalReportSchema, type Task, type ReviewResult, type FinalReport } from '../state/schemas.js';
import { saveArtifact, appendLog } from '../artifacts/index.js';
import { isWorkspaceRoot, readWorkspaceManifest, resolveRepoPath, type WorkspaceManifest } from '../workspace/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskAuditInfo {
  task: Task;
  latestReview: ReviewResult | null;
}

export interface AuditResultData {
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
  summary: string;
  concerns: string[];
  created_at: string;
}

export interface AuditResult extends AuditResultData {
  promptPath: string;
  rawOutputPath: string;
  auditResultPath: string;
}

export interface ReportResult {
  reportPath: string;
  reportJsonPath: string;
  finalReport: FinalReport;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export async function runAudit(repoRoot: string): Promise<AuditResult> {
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, null, 'audit: starting');

  const infos = await loadTaskAuditInfos(resolvedRepo);
  if (infos.length === 0) {
    throw new Error(`No tasks found — run 'orchestrator plan' first`);
  }

  const manifest = await loadManifestIfWorkspace(resolvedRepo);
  const prompt = buildAuditPrompt(resolvedRepo, infos, manifest);
  const promptPath = await saveArtifact(resolvedRepo, 'prompts', null, 'audit-prompt.md', prompt);
  console.log(`  Audit prompt saved: ${promptPath}`);

  console.log('  Running Codex CLI for audit...');
  const codexResult = await runCommand('codex', ['--quiet', prompt], {
    cwd: resolvedRepo,
    timeoutMs: 180_000,
  });

  const rawOutput = formatRawOutput(codexResult.stdout, codexResult.stderr, codexResult.exitCode);
  const rawOutputPath = await saveArtifact(resolvedRepo, 'reports', null, 'audit-raw.md', rawOutput);
  console.log(`  Raw audit saved: ${rawOutputPath}`);

  const auditData = extractAuditResult(codexResult.stdout, infos);

  const auditResultPath = join(orchestratorPaths.reports(resolvedRepo), 'audit-result.json');
  await writeJson(auditResultPath, auditData);
  console.log(`  Audit result saved: ${auditResultPath}`);

  await appendLog(resolvedRepo, null, `audit: complete — overall=${auditData.overall}`);

  return { ...auditData, promptPath, rawOutputPath, auditResultPath };
}

// ─── Report ───────────────────────────────────────────────────────────────────

export async function generateReport(repoRoot: string, auditSummary = ''): Promise<ReportResult> {
  const resolvedRepo = resolve(repoRoot);
  await appendLog(resolvedRepo, null, 'report: generating');

  const infos = await loadTaskAuditInfos(resolvedRepo);
  if (infos.length === 0) {
    throw new Error(`No tasks found — run 'orchestrator plan' first`);
  }

  const manifest = await loadManifestIfWorkspace(resolvedRepo);

  const passed  = infos.filter((i) => i.task.status === 'passed').length;
  const failed  = infos.filter((i) => i.task.status === 'failed').length;
  const blocked = infos.filter((i) => i.task.status === 'blocked').length;

  const now = new Date().toISOString();

  const finalReport: FinalReport = {
    version: '1',
    repo_path: resolvedRepo,
    generated_at: now,
    total_tasks: infos.length,
    passed,
    failed,
    blocked,
    task_summaries: infos.map((i) => ({
      id: i.task.id,
      title: i.task.title,
      status: i.task.status,
      retry_count: i.task.retry_count,
      verdict: i.latestReview?.verdict ?? null,
      ...(i.task.repo_id ? { repo_id: i.task.repo_id } : {}),
    })),
    audit_summary: auditSummary,
  };

  const reportDir = orchestratorPaths.reports(resolvedRepo);
  const reportJsonPath = join(reportDir, 'final-report.json');
  await writeJson(reportJsonPath, finalReport);

  const markdown = buildReportMarkdown(finalReport, infos, manifest);
  const reportPath = await saveArtifact(resolvedRepo, 'reports', null, 'report.md', markdown);
  console.log(`  Report saved: ${reportPath}`);

  await appendLog(resolvedRepo, null, `report: complete — ${reportPath}`);

  return { reportPath, reportJsonPath, finalReport };
}

// ─── Audit prompt ─────────────────────────────────────────────────────────────

export function buildAuditPrompt(
  repoRoot: string,
  infos: TaskAuditInfo[],
  manifest: WorkspaceManifest | null = null,
): string {
  const isWorkspace = manifest !== null;

  const rows = infos.map((i) => {
    const verdict = i.latestReview?.verdict ?? 'n/a';
    const retries = i.task.retry_count;
    if (isWorkspace) {
      const repoId = i.task.repo_id ?? '—';
      return `| ${i.task.id} | ${repoId} | ${i.task.title} | ${i.task.status} | ${retries} | ${verdict} |`;
    }
    return `| ${i.task.id} | ${i.task.title} | ${i.task.status} | ${retries} | ${verdict} |`;
  });

  const tableHeader = isWorkspace
    ? [
        `| ID | Repo | Title | Status | Retries | Final Verdict |`,
        `|----|------|-------|--------|---------|---------------|`,
      ].join('\n')
    : [
        `| ID | Title | Status | Retries | Final Verdict |`,
        `|----|-------|--------|---------|---------------|`,
      ].join('\n');

  const problemTasks = infos.filter(
    (i) => i.task.status === 'blocked' || i.task.status === 'failed',
  );

  const problemSection = problemTasks.length === 0
    ? '_None_'
    : problemTasks.map((i) => {
        const issues = i.latestReview?.issues_found ?? [];
        const issueText = issues.length > 0
          ? issues.map((x) => `  - ${x}`).join('\n')
          : '  (no review issues recorded)';
        const repoTag = i.task.repo_id ? ` [${i.task.repo_id}]` : '';
        return `**${i.task.id}${repoTag} — ${i.task.title}** (${i.task.status})\n${issueText}`;
      }).join('\n\n');

  // In workspace mode, print a short list of declared repos so Codex can reason
  // about which repo each task belongs to without dumping full context.
  const repoSection = isWorkspace
    ? [
        `## Workspace`,
        `Root: ${repoRoot}`,
        ``,
        `Declared repositories:`,
        ...manifest!.repos.map((r) => {
          const absPath = resolveRepoPath(repoRoot, r);
          const desc = r.description ? ` — ${r.description}` : '';
          return `- **${r.id}**: ${absPath}${desc}`;
        }),
      ].join('\n')
    : `## Repository\n${repoRoot}`;

  const repoIdNote = isWorkspace
    ? `Tasks may span multiple repositories. The \`Repo\` column identifies which repo each task belongs to. Evaluate the workspace as a whole.\n\n`
    : '';

  return `You are auditing the final state of ${isWorkspace ? 'a multi-repo workspace' : 'a repository'} after an automated implementation run.

${repoSection}

## Task Results
${repoIdNote}${tableHeader}
${rows.join('\n')}

## Blocked / Failed Tasks
${problemSection}

## Your Task
Review the overall implementation quality based on the above task results. Provide a concise, honest assessment.

Return ONLY valid JSON in this exact shape:
\`\`\`json
{
  "overall": "PASS",
  "summary": "One to three sentences describing what was accomplished and any major concerns.",
  "concerns": ["concern 1", "concern 2"]
}
\`\`\`

- overall must be "PASS", "PARTIAL", or "FAIL"
- concerns may be an empty array if there are none
- Do not include any text outside the JSON block`;
}

// ─── Audit extraction ─────────────────────────────────────────────────────────

export function extractAuditResult(raw: string, infos: TaskAuditInfo[]): AuditResultData {
  const created_at = new Date().toISOString();

  // Try JSON code block first
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return {
        overall: normalizeOverall(parsed.overall),
        summary: String(parsed.summary ?? ''),
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
        created_at,
      };
    } catch {
      // fall through
    }
  }

  // Try bare JSON
  try {
    const parsed = JSON.parse(raw.trim());
    return {
      overall: normalizeOverall(parsed.overall),
      summary: String(parsed.summary ?? ''),
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
      created_at,
    };
  } catch {
    // fall through
  }

  // Fallback: derive overall from task statuses, use raw output as summary
  const blocked = infos.filter((i) => i.task.status === 'blocked').length;
  const failed  = infos.filter((i) => i.task.status === 'failed').length;
  const overall: AuditResultData['overall'] =
    blocked + failed === 0 ? 'PASS' : blocked + failed < infos.length ? 'PARTIAL' : 'FAIL';

  return {
    overall,
    summary: raw.trim().slice(0, 500) || '(no audit output)',
    concerns: [],
    created_at,
  };
}

function normalizeOverall(value: unknown): AuditResult['overall'] {
  if (value === 'PASS' || value === 'PARTIAL' || value === 'FAIL') return value;
  return 'PARTIAL';
}

// ─── Markdown report ──────────────────────────────────────────────────────────

function buildReportMarkdown(
  report: FinalReport,
  infos: TaskAuditInfo[],
  manifest: WorkspaceManifest | null = null,
): string {
  const date = new Date(report.generated_at).toUTCString();
  const isWorkspace = manifest !== null;
  const lines: string[] = [];

  lines.push(`# Orchestration Report`);
  lines.push('');
  lines.push(`- **Generated:** ${date}`);
  if (isWorkspace) {
    lines.push(`- **Workspace root:** ${report.repo_path}`);
  } else {
    lines.push(`- **Repository:** ${report.repo_path}`);
  }
  lines.push('');

  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tasks | ${report.total_tasks} |`);
  lines.push(`| Passed | ${report.passed} |`);
  lines.push(`| Failed | ${report.failed} |`);
  lines.push(`| Blocked | ${report.blocked} |`);
  lines.push('');

  // Per-repo summary — only when workspace mode is active.
  if (isWorkspace) {
    lines.push(`## Repositories`);
    lines.push('');
    lines.push(`| Repo | Path | Tasks | Passed | Failed | Blocked |`);
    lines.push(`|------|------|-------|--------|--------|---------|`);
    for (const r of manifest!.repos) {
      const absPath = resolveRepoPath(report.repo_path, r);
      const repoTasks = infos.filter((i) => i.task.repo_id === r.id);
      const p = repoTasks.filter((i) => i.task.status === 'passed').length;
      const f = repoTasks.filter((i) => i.task.status === 'failed').length;
      const b = repoTasks.filter((i) => i.task.status === 'blocked').length;
      lines.push(`| ${r.id} | ${absPath} | ${repoTasks.length} | ${p} | ${f} | ${b} |`);
    }
    lines.push('');
  }

  if (report.audit_summary) {
    lines.push(`## Audit`);
    lines.push('');
    lines.push(report.audit_summary);
    lines.push('');
  }

  lines.push(`## Tasks`);
  lines.push('');

  const infoById = new Map(infos.map((i) => [i.task.id, i]));
  for (const summary of report.task_summaries) {
    const info = infoById.get(summary.id);
    const review = info?.latestReview ?? null;
    const repoTag = summary.repo_id ? ` [${summary.repo_id}]` : '';

    lines.push(`### ${summary.id}${repoTag}: ${summary.title}`);
    lines.push('');
    if (summary.repo_id) {
      lines.push(`- **Repo:** ${summary.repo_id}`);
    }
    lines.push(`- **Status:** ${summary.status}`);
    lines.push(`- **Retries:** ${summary.retry_count}`);
    lines.push(`- **Final verdict:** ${summary.verdict ?? 'n/a'}`);

    if (review?.summary) {
      lines.push(`- **Review summary:** ${review.summary}`);
    }

    if (review && review.acceptance_checklist.length > 0) {
      lines.push('');
      lines.push('**Acceptance checklist:**');
      for (const item of review.acceptance_checklist) {
        const mark = item.passed ? '✓' : '✗';
        lines.push(`- ${mark} ${item.criterion}`);
      }
    }

    if (review && review.issues_found.length > 0) {
      lines.push('');
      lines.push('**Issues found:**');
      for (const issue of review.issues_found) {
        lines.push(`- ${issue}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Load the workspace manifest when one exists. Returns null **only** when there
 * is no `repos.json` at all (single-repo mode). If the manifest file is present
 * but malformed, the underlying read/validate error is propagated so audit and
 * report fail loudly instead of silently treating the workspace as a single repo.
 */
async function loadManifestIfWorkspace(root: string): Promise<WorkspaceManifest | null> {
  if (!(await isWorkspaceRoot(root))) return null;
  return readWorkspaceManifest(root);
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadTaskAuditInfos(repoRoot: string): Promise<TaskAuditInfo[]> {
  const taskList = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
  if (!taskList) return [];

  return Promise.all(
    taskList.tasks.map(async (task) => ({
      task,
      latestReview: await findLatestReviewResult(repoRoot, task.id),
    })),
  );
}

async function findLatestReviewResult(repoRoot: string, taskId: string): Promise<ReviewResult | null> {
  const dir = join(orchestratorPaths.reviews(repoRoot), taskId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  const matches = files
    .filter((f) => f.includes('review-result-attempt-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (matches.length === 0) return null;
  return readJson(join(dir, matches[0]), ReviewResultSchema);
}

// ─── Shared util ──────────────────────────────────────────────────────────────

function formatRawOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = [`<!-- exit code: ${exitCode} -->`];
  if (stdout) parts.push(`## stdout\n\n${stdout}`);
  if (stderr) parts.push(`## stderr\n\n${stderr}`);
  if (parts.length === 1) parts.push('(no output)');
  return parts.join('\n\n');
}
