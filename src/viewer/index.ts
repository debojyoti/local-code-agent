import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { readJson } from '../state/persist.js';
import { orchestratorPaths } from '../state/paths.js';
import {
  TaskListSchema,
  StateSchema,
  ReviewResultSchema,
  ExecutionResultSchema,
  type Task,
  type ReviewResult,
  type ExecutionResult,
} from '../state/schemas.js';

// ─── Entry point ──────────────────────────────────────────────────────────────

export interface ViewerOptions {
  port?: number;
}

export async function startViewer(repoRoot: string, opts: ViewerOptions = {}): Promise<void> {
  const resolvedRepo = resolve(repoRoot);
  const port = opts.port ?? 7842;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/' || url === '') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await renderOverview(resolvedRepo));
      } else if (url.startsWith('/task/')) {
        const taskId = decodeURIComponent(url.slice('/task/'.length));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await renderTaskDetail(resolvedRepo, taskId));
      } else if (url === '/report') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await renderReport(resolvedRepo));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`  Viewer:  http://127.0.0.1:${port}`);
      console.log(`  Repo:    ${resolvedRepo}`);
      console.log('  Press Ctrl+C to stop\n');
      resolvePromise();
    });
    server.on('error', reject);
  });

  // Keep the process alive until Ctrl+C
  await new Promise<void>((_resolve, reject) => {
    server.on('error', reject);
    process.on('SIGINT', () => {
      server.close();
      process.exit(0);
    });
  });
}

// ─── Pages ────────────────────────────────────────────────────────────────────

export async function renderOverview(repoRoot: string): Promise<string> {
  const [taskList, state] = await Promise.all([
    readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema),
    readJson(orchestratorPaths.state(repoRoot), StateSchema),
  ]);

  const statusLine = state
    ? `<p>Orchestrator status: ${badge(state.status)}${state.current_task_id ? ` &mdash; current task: <strong>${esc(state.current_task_id)}</strong>` : ''}</p>`
    : `<p><em>No state found. Run <code>orchestrator plan</code> first.</em></p>`;

  if (!taskList || taskList.tasks.length === 0) {
    return page('Tasks', `${statusLine}<p><em>No tasks found.</em></p>`);
  }

  // Show the Repo column only when at least one task carries a repo_id.
  // This keeps single-repo output identical to before.
  const showRepoColumn = taskList.tasks.some((t) => t.repo_id);

  const rows = taskList.tasks.map((t) => {
    const repoCell = showRepoColumn ? `<td>${t.repo_id ? esc(t.repo_id) : '&mdash;'}</td>` : '';
    return `
    <tr>
      <td><a href="/task/${encodeURIComponent(t.id)}">${esc(t.id)}</a></td>
      ${repoCell}
      <td>${esc(t.title)}</td>
      <td>${badge(t.status)}</td>
      <td>${t.retry_count}</td>
      <td>${t.dependencies.length > 0 ? esc(t.dependencies.join(', ')) : '&mdash;'}</td>
    </tr>`;
  }).join('');

  const headerCells = showRepoColumn
    ? '<th>ID</th><th>Repo</th><th>Title</th><th>Status</th><th>Retries</th><th>Dependencies</th>'
    : '<th>ID</th><th>Title</th><th>Status</th><th>Retries</th><th>Dependencies</th>';

  const body = `
    <h1>Task Overview</h1>
    ${statusLine}
    <p>${summaryCounts(taskList.tasks)}</p>
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  return page('Tasks', body);
}

export async function renderTaskDetail(repoRoot: string, taskId: string): Promise<string> {
  const taskList = await readJson(orchestratorPaths.tasks(repoRoot), TaskListSchema);
  const task = taskList?.tasks.find((t) => t.id === taskId);

  if (!task) {
    return page(`Task ${esc(taskId)}`, `<p>Task <strong>${esc(taskId)}</strong> not found.</p><p><a href="/">&larr; Back</a></p>`);
  }

  const [brief, review, execution] = await Promise.all([
    findLatestBrief(repoRoot, taskId),
    findLatestReviewResult(repoRoot, taskId),
    findLatestExecutionResult(repoRoot, taskId),
  ]);

  const criteria = task.acceptance_criteria.length > 0
    ? `<h2>Acceptance Criteria</h2><ul>${task.acceptance_criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
    : '';

  // When in workspace mode, surface the task's repo near the status.
  const repoLine = task.repo_id
    ? `<p>Repo: <strong>${esc(task.repo_id)}</strong></p>`
    : '';

  const body = `
    <h1>${esc(task.id)}: ${esc(task.title)}</h1>
    ${repoLine}
    <p>${badge(task.status)} &nbsp; Retries: ${task.retry_count}&thinsp;/&thinsp;${task.max_retries}</p>
    <h2>Goal</h2>
    <p>${esc(task.goal)}</p>
    ${criteria}
    ${renderReviewSection(review)}
    ${renderExecutionSection(execution)}
    ${renderBriefSection(brief)}
    <p style="margin-top:2rem"><a href="/">&larr; Back to task list</a></p>`;

  return page(`${task.id}: ${task.title}`, body);
}

async function renderReport(repoRoot: string): Promise<string> {
  const reportsDir = orchestratorPaths.reports(repoRoot);
  let reportMd: string | null = null;

  try {
    const files = await readdir(reportsDir);
    const mdFiles = files.filter((f) => f.endsWith('report.md')).sort().reverse();
    if (mdFiles.length > 0) {
      reportMd = await readFile(join(reportsDir, mdFiles[0]), 'utf8');
    }
  } catch {
    // reports dir doesn't exist yet
  }

  if (!reportMd) {
    return page('Report', '<p><em>No report found. Run <code>orchestrator report --repo &lt;path&gt;</code> first.</em></p><p><a href="/">&larr; Back</a></p>');
  }

  const body = `
    <h1>Orchestration Report</h1>
    <pre>${esc(reportMd)}</pre>
    <p><a href="/">&larr; Back to task list</a></p>`;

  return page('Report', body);
}

// ─── Section renderers ────────────────────────────────────────────────────────

function renderReviewSection(review: ReviewResult | null): string {
  if (!review) {
    return '<h2>Latest Review</h2><p><em>No review result found.</em></p>';
  }

  const checklist = review.acceptance_checklist.length > 0
    ? `<ul>${review.acceptance_checklist.map((item) =>
        `<li>${item.passed ? '✓' : '✗'} ${esc(item.criterion)}</li>`
      ).join('')}</ul>`
    : '';

  const issues = review.issues_found.length > 0
    ? `<p><strong>Issues:</strong></p><ul>${review.issues_found.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '';

  return `
    <h2>Latest Review (attempt ${review.attempt})</h2>
    <p>Verdict: ${badge(review.verdict)} &nbsp; Confidence: ${Math.round(review.confidence * 100)}%</p>
    <p>${esc(review.summary)}</p>
    ${checklist}
    ${issues}`;
}

function renderExecutionSection(execution: ExecutionResult | null): string {
  if (!execution) {
    return '<h2>Latest Execution</h2><p><em>No execution result found.</em></p>';
  }

  const checks = execution.checks.length > 0
    ? `<p><strong>Checks:</strong></p><ul>${execution.checks.map((c) =>
        `<li>${c.ok ? '✓' : '✗'} <code>${esc(c.name)}</code>: exit ${c.exit_code}</li>`
      ).join('')}</ul>`
    : '';

  const files = execution.changed_files.length > 0
    ? `<ul>${execution.changed_files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
    : '<p><em>No changed files recorded.</em></p>';

  const diff = execution.diff
    ? `<details><summary>Show diff</summary><pre>${esc(execution.diff)}</pre></details>`
    : '';

  return `
    <h2>Latest Execution (attempt ${execution.attempt})</h2>
    <p>Exit code: <code>${execution.exit_code}</code> &nbsp; ${execution.ok ? '✓ checks passed' : '✗ checks failed'}</p>
    ${checks}
    <p><strong>Changed files:</strong></p>
    ${files}
    ${diff}`;
}

function renderBriefSection(brief: string | null): string {
  if (!brief) return '';
  return `<h2>Implementation Brief</h2><details><summary>Show brief</summary><pre>${esc(brief)}</pre></details>`;
}

// ─── Artifact loaders ─────────────────────────────────────────────────────────

async function findLatestReviewResult(repoRoot: string, taskId: string): Promise<ReviewResult | null> {
  const dir = join(orchestratorPaths.reviews(repoRoot), taskId);
  try {
    const files = await readdir(dir);
    const matches = files
      .filter((f) => f.includes('review-result-attempt-') && f.endsWith('.json'))
      .sort().reverse();
    if (matches.length === 0) return null;
    return readJson(join(dir, matches[0]), ReviewResultSchema);
  } catch {
    return null;
  }
}

async function findLatestExecutionResult(repoRoot: string, taskId: string): Promise<ExecutionResult | null> {
  const dir = join(orchestratorPaths.artifacts(repoRoot), taskId);
  try {
    const files = await readdir(dir);
    const matches = files
      .filter((f) => f.includes('execution-result-attempt-') && f.endsWith('.json'))
      .sort().reverse();
    if (matches.length === 0) return null;
    return readJson(join(dir, matches[0]), ExecutionResultSchema);
  } catch {
    return null;
  }
}

async function findLatestBrief(repoRoot: string, taskId: string): Promise<string | null> {
  const dir = join(orchestratorPaths.prompts(repoRoot), taskId);
  try {
    const files = await readdir(dir);
    const matches = files.filter((f) => f.includes('implementation-brief.md')).sort().reverse();
    if (matches.length === 0) return null;
    return readFile(join(dir, matches[0]), 'utf8');
  } catch {
    return null;
  }
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

const STATUS_CLASS: Record<string, string> = {
  // task statuses
  passed: 'passed', complete: 'passed', PASS: 'passed',
  failed: 'failed', FAIL: 'failed',
  blocked: 'blocked', BLOCKED: 'blocked', PARTIAL: 'blocked',
  running: 'active', reviewing: 'active', revise: 'active', REVISE: 'active', planning: 'active',
  pending: 'neutral', ready: 'neutral', idle: 'neutral', paused: 'neutral',
};

function badge(status: string): string {
  const cls = STATUS_CLASS[status] ?? 'neutral';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function summaryCounts(tasks: Task[]): string {
  const total   = tasks.length;
  const passed  = tasks.filter((t) => t.status === 'passed').length;
  const failed  = tasks.filter((t) => t.status === 'failed').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const other   = total - passed - failed - blocked;
  return `${total} tasks &mdash; ${passed} passed &middot; ${failed} failed &middot; ${blocked} blocked &middot; ${other} other`;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Orchestrator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1.25rem; color: #1a1a1a; line-height: 1.5; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; }
  th, td { padding: 0.45rem 0.75rem; text-align: left; border: 1px solid #ddd; }
  th { background: #f5f5f5; font-weight: 600; }
  tr:hover td { background: #fafafa; }
  .badge { display: inline-block; padding: 0.15em 0.55em; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .passed  { background: #d4edda; color: #155724; }
  .failed  { background: #f8d7da; color: #721c24; }
  .blocked { background: #fff3cd; color: #856404; }
  .active  { background: #cce5ff; color: #004085; }
  .neutral { background: #e2e3e5; color: #383d41; }
  pre { background: #f8f8f8; border: 1px solid #ddd; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; border-radius: 4px; margin: 0.5rem 0; }
  details summary { cursor: pointer; color: #0066cc; padding: 0.25rem 0; }
  nav { border-bottom: 1px solid #ddd; padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
  nav a { margin-right: 1.25rem; font-weight: 500; }
  code { background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
  ul { margin: 0.25rem 0; padding-left: 1.5rem; }
  li { margin: 0.2rem 0; }
  p { margin: 0.5rem 0; }
</style>
</head>
<body>
<nav><a href="/">Tasks</a><a href="/report">Report</a></nav>
${body}
</body>
</html>`;
}
