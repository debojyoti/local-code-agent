#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { runDoctor } from '../core/doctor.js';
import { runPlan } from '../planner/index.js';
import { runPlanRefine } from '../planner/refine.js';
import { runTask } from '../executor/index.js';
import { runReview } from '../review/index.js';
import { runTaskLoop } from '../executor/loop.js';
import { orchestratorPaths } from '../state/paths.js';
import { runOrchestration } from '../core/orchestrator.js';
import { runAudit, generateReport } from '../reporting/index.js';
import { startViewer } from '../viewer/index.js';
import { initWorkspaceScaffold, parseRepoEntries } from '../workspace/init.js';
import { promptForWorkspaceInit } from '../workspace/prompt.js';

const program = new Command();

program
  .name('orchestrator')
  .description('Local AI coding orchestrator using Codex CLI and Claude Code CLI')
  .version('0.1.0');

// Commands will be registered here as they are implemented
program.command('init').description('Initialize local config and templates').action(() => {
  console.log('init: not yet implemented');
});

program
  .command('init-workspace')
  .description('Initialize a multi-repo workspace scaffold under .ai-orchestrator/')
  .option('--repo <path>', 'Workspace root path (defaults to cwd)')
  .option('--repos <items>', 'Comma-separated repo entries like frontend=./frontend,backend=./backend')
  .option('--interactive', 'Prompt for workspace root and repo entries interactively')
  .option('--force', 'Overwrite existing repos.json and spec.md if present')
  .action(async (opts: { repo?: string; repos?: string; interactive?: boolean; force?: boolean }) => {
    const defaultWorkspaceRoot = resolve(opts.repo ?? process.cwd());

    console.log('\nOrchestrator Init Workspace\n' + '─'.repeat(40));
    console.log(`  workspace: ${defaultWorkspaceRoot}\n`);

    try {
      let workspaceRoot = defaultWorkspaceRoot;
      let repos;
      let force = opts.force === true;

      if (opts.interactive || !opts.repos) {
        const answers = await promptForWorkspaceInit(defaultWorkspaceRoot);
        workspaceRoot = resolve(answers.workspaceRoot);
        repos = answers.repos;
        force = answers.force;
      } else {
        repos = parseRepoEntries(opts.repos);
      }

      const result = await initWorkspaceScaffold(workspaceRoot, repos, force);

      console.log('Workspace scaffold created\n' + '─'.repeat(40));
      console.log(`  Manifest: ${result.reposPath}`);
      console.log(`  Spec:     ${result.specPath}`);
      console.log(`  Repos:    ${result.repos.map((r) => `${r.id}=${r.path}`).join(', ')}`);
      console.log('\nNext steps:');
      console.log(`  1. Edit ${result.specPath}`);
      console.log(`  2. Run: npm run dev -- doctor --repo ${result.workspaceRoot}`);
      console.log(`  3. Run: npm run dev -- plan --repo ${result.workspaceRoot} --spec ${result.specPath}\n`);
    } catch (err) {
      console.error(`\ninit-workspace failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Verify required CLI tools and environment')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .action(async (opts: { repo?: string }) => {
    const ok = await runDoctor(opts.repo);
    if (!ok) process.exit(1);
  });

program
  .command('plan')
  .description('Analyze repo and generate ordered task plan using Codex CLI')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--spec <path>', 'Path to spec file (defaults to .ai-orchestrator/spec.md)')
  .action(async (opts: { repo?: string; spec?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());
    const specPath = opts.spec ?? orchestratorPaths.spec(repoRoot);

    console.log('\nOrchestrator Plan\n' + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}`);
    console.log(`  spec: ${specPath}\n`);

    try {
      const result = await runPlan(repoRoot, specPath);

      console.log('\nPlan complete\n' + '─'.repeat(40));
      console.log(`  Tasks saved: ${result.tasksPath}`);
      console.log(`  Prompt:      ${result.promptArtifactPath}`);
      console.log(`  Raw output:  ${result.rawOutputArtifactPath}`);

      console.log(`\nRepo summary: ${result.planningOutput.repo_summary}\n`);

      console.log(`Tasks (${result.tasks.length}):`);
      for (const task of result.tasks) {
        const deps = task.dependencies.length > 0 ? ` [deps: ${task.dependencies.join(', ')}]` : '';
        console.log(`  ${task.id}  ${task.title}${deps}`);
      }

      if (result.planningOutput.risks.length > 0) {
        console.log(`\nRisks:`);
        for (const risk of result.planningOutput.risks) {
          console.log(`  - ${risk}`);
        }
      }

      console.log('');
    } catch (err) {
      console.error(`\nplan failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('plan-refine')
  .description('Refine the existing plan with additional feedback using Codex CLI')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--feedback <text>', 'Inline feedback text')
  .option('--feedback-file <path>', 'Path to a file containing feedback')
  .action(async (opts: { repo?: string; feedback?: string; feedbackFile?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());

    let feedback: string;
    if (opts.feedbackFile) {
      try {
        feedback = await readFile(resolve(opts.feedbackFile), 'utf8');
      } catch {
        console.error(`plan-refine: cannot read feedback file: ${opts.feedbackFile}`);
        process.exit(1);
      }
    } else if (opts.feedback) {
      feedback = opts.feedback;
    } else {
      console.error('plan-refine: --feedback <text> or --feedback-file <path> is required');
      process.exit(1);
    }

    console.log('\nOrchestrator Plan Refine\n' + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}\n`);

    try {
      const result = await runPlanRefine(repoRoot, { feedback });

      console.log('\nPlan refined\n' + '─'.repeat(40));
      console.log(`  Tasks saved: ${result.tasksPath}`);
      console.log(`  Prompt:      ${result.promptArtifactPath}`);
      console.log(`  Raw output:  ${result.rawOutputArtifactPath}`);
      console.log(`\nChanges:`);
      console.log(`  Added:   ${result.added.length > 0 ? result.added.join(', ') : '(none)'}`);
      console.log(`  Removed: ${result.removed.length > 0 ? result.removed.join(', ') : '(none)'}`);
      console.log(`  Kept:    ${result.kept.length} task(s)`);
      console.log(`\nTasks (${result.tasks.length}):`);
      for (const task of result.tasks) {
        const deps = task.dependencies.length > 0 ? ` [deps: ${task.dependencies.join(', ')}]` : '';
        console.log(`  ${task.id}  ${task.title}${deps}`);
      }
      console.log('');
    } catch (err) {
      console.error(`\nplan-refine failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('run')
  .description('Run all pending tasks in dependency order')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .action(async (opts: { repo?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());

    console.log('\nOrchestrator Run\n' + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}\n`);

    try {
      const result = await runOrchestration(repoRoot, false);

      console.log('\n' + '─'.repeat(50));
      console.log('  Run complete');
      console.log('─'.repeat(50));
      console.log(`  Total:   ${result.total}`);
      console.log(`  Passed:  ${result.passed}`);
      console.log(`  Failed:  ${result.failed}`);
      console.log(`  Blocked: ${result.blocked}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log('');

      if (result.failed > 0 || result.blocked > 0) process.exit(1);
    } catch (err) {
      console.error(`\nrun failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('run-task')
  .description('Run a single task by ID')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--task <id>', 'Task ID to run')
  .action(async (opts: { repo?: string; task?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());
    const taskId = opts.task;

    if (!taskId) {
      console.error('run-task: --task <id> is required');
      process.exit(1);
    }

    console.log(`\nOrchestrator Run Task\n` + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}`);
    console.log(`  task: ${taskId}\n`);

    try {
      const result = await runTask(repoRoot, taskId);
      const r = result.executionResult;

      console.log(`\nRun Task complete\n` + '─'.repeat(40));
      console.log(`  Status:          ${result.task.status}`);
      console.log(`  Attempt:         ${r.attempt}`);
      console.log(`  Exit code:       ${r.exit_code}`);
      console.log(`  Changed files:   ${r.changed_files.length}`);
      if (r.changed_files.length > 0) {
        for (const f of r.changed_files) console.log(`    ${f}`);
      }
      console.log(`  Brief:           ${result.briefPath}`);
      console.log(`  Claude output:   ${result.claudeOutputPath}`);
      console.log(`  Execution result:${result.executionResultPath}`);
      console.log('');
    } catch (err) {
      console.error(`\nrun-task failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('review')
  .description('Run Codex review for an existing task')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--task <id>', 'Task ID to review')
  .action(async (opts: { repo?: string; task?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());
    const taskId = opts.task;

    if (!taskId) {
      console.error('review: --task <id> is required');
      process.exit(1);
    }

    console.log(`\nOrchestrator Review\n` + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}`);
    console.log(`  task: ${taskId}\n`);

    try {
      const result = await runReview(repoRoot, taskId);
      const r = result.reviewResult;

      console.log(`\nReview complete\n` + '─'.repeat(40));
      console.log(`  Verdict:    ${r.verdict}`);
      console.log(`  Confidence: ${(r.confidence * 100).toFixed(0)}%`);
      console.log(`  Status:     ${result.task.status}`);
      console.log(`  Summary:    ${r.summary}`);

      if (r.acceptance_checklist.length > 0) {
        console.log(`\nAcceptance checklist:`);
        for (const item of r.acceptance_checklist) {
          const mark = item.passed ? '✓' : '✗';
          console.log(`  ${mark} ${item.criterion}`);
        }
      }

      if (r.issues_found.length > 0) {
        console.log(`\nIssues found:`);
        for (const issue of r.issues_found) {
          console.log(`  - ${issue}`);
        }
      }

      if (r.verdict === 'REVISE' && r.fix_brief) {
        console.log(`\nFix brief:\n${r.fix_brief.split('\n').map((l) => `  ${l}`).join('\n')}`);
      }

      console.log(`\n  Prompt:        ${result.promptPath}`);
      console.log(`  Raw output:    ${result.rawOutputPath}`);
      console.log(`  Review result: ${result.reviewResultPath}`);
      console.log('');
    } catch (err) {
      console.error(`\nreview failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('execute')
  .description('Run a single task through the full execute → review → revise loop')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--task <id>', 'Task ID to execute')
  .action(async (opts: { repo?: string; task?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());
    const taskId = opts.task;

    if (!taskId) {
      console.error('execute: --task <id> is required');
      process.exit(1);
    }

    console.log(`\nOrchestrator Execute\n` + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}`);
    console.log(`  task: ${taskId}\n`);

    try {
      const result = await runTaskLoop(repoRoot, taskId);

      console.log(`\nExecute complete\n` + '─'.repeat(40));
      console.log(`  Stop reason:  ${result.stoppedReason}`);
      console.log(`  Final status: ${result.task.status}`);
      console.log(`  Attempts:     ${result.attempts.length}`);

      for (const a of result.attempts) {
        const verdictStr = a.verdict ?? 'n/a';
        const execStr = a.executionOk ? 'ok' : 'fail';
        console.log(`    #${a.attemptNum}  exec=${execStr}  verdict=${verdictStr}`);
      }

      console.log('');

      if (result.stoppedReason !== 'pass') {
        process.exit(1);
      }
    } catch (err) {
      console.error(`\nexecute failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('audit')
  .description('Run final repo-wide verification with Codex CLI')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .action(async (opts: { repo?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());

    console.log('\nOrchestrator Audit\n' + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}\n`);

    try {
      const audit = await runAudit(repoRoot);

      console.log('\nAudit complete\n' + '─'.repeat(40));
      console.log(`  Overall:  ${audit.overall}`);
      console.log(`  Summary:  ${audit.summary}`);
      if (audit.concerns.length > 0) {
        console.log('\nConcerns:');
        for (const c of audit.concerns) console.log(`  - ${c}`);
      }
      console.log(`\n  Prompt:     ${audit.promptPath}`);
      console.log(`  Raw output: ${audit.rawOutputPath}`);
      console.log('');

      if (audit.overall === 'FAIL') process.exit(1);
    } catch (err) {
      console.error(`\naudit failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('resume')
  .description('Continue from persisted state')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .action(async (opts: { repo?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());

    console.log('\nOrchestrator Resume\n' + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}\n`);

    try {
      const result = await runOrchestration(repoRoot, true);

      console.log('\n' + '─'.repeat(50));
      console.log('  Resume complete');
      console.log('─'.repeat(50));
      console.log(`  Total:   ${result.total}`);
      console.log(`  Passed:  ${result.passed}`);
      console.log(`  Failed:  ${result.failed}`);
      console.log(`  Blocked: ${result.blocked}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log('');

      if (result.failed > 0 || result.blocked > 0) process.exit(1);
    } catch (err) {
      console.error(`\nresume failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('report')
  .description('Generate markdown report with task history and final status')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--audit', 'Run Codex audit before generating the report')
  .action(async (opts: { repo?: string; audit?: boolean }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());

    console.log('\nOrchestrator Report\n' + '─'.repeat(40));
    console.log(`  repo: ${repoRoot}\n`);

    try {
      let auditSummary = '';

      if (opts.audit) {
        console.log('Running audit first...\n');
        const audit = await runAudit(repoRoot);
        auditSummary = `**Overall: ${audit.overall}**\n\n${audit.summary}`;
        if (audit.concerns.length > 0) {
          auditSummary += '\n\n**Concerns:**\n' + audit.concerns.map((c) => `- ${c}`).join('\n');
        }
        console.log(`\n  Audit: ${audit.overall} — ${audit.summary}\n`);
      }

      const result = await generateReport(repoRoot, auditSummary);
      const r = result.finalReport;

      console.log('\nReport complete\n' + '─'.repeat(40));
      console.log(`  Total:   ${r.total_tasks}`);
      console.log(`  Passed:  ${r.passed}`);
      console.log(`  Failed:  ${r.failed}`);
      console.log(`  Blocked: ${r.blocked}`);
      console.log(`\n  Markdown: ${result.reportPath}`);
      console.log(`  JSON:     ${result.reportJsonPath}`);
      console.log('');
    } catch (err) {
      console.error(`\nreport failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('viewer')
  .description('Start a read-only local viewer for orchestrator state and artifacts')
  .option('--repo <path>', 'Path to target repository (defaults to cwd)')
  .option('--port <number>', 'Port to listen on (default: 7842)', '7842')
  .action(async (opts: { repo?: string; port?: string }) => {
    const repoRoot = resolve(opts.repo ?? process.cwd());
    const port = parseInt(opts.port ?? '7842', 10);

    console.log('\nOrchestrator Viewer\n' + '─'.repeat(40));

    try {
      await startViewer(repoRoot, { port });
    } catch (err) {
      console.error(`\nviewer failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program.parse(process.argv);
