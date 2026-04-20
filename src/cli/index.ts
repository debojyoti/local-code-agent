#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'path';
import { runDoctor } from '../core/doctor.js';
import { runPlan } from '../planner/index.js';
import { runTask } from '../executor/index.js';
import { orchestratorPaths } from '../state/paths.js';

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
  .command('run')
  .description('Run all pending tasks in order')
  .option('--repo <path>', 'Path to target repository')
  .action(() => {
    console.log('run: not yet implemented');
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
  .option('--repo <path>', 'Path to target repository')
  .option('--task <id>', 'Task ID to review')
  .action(() => {
    console.log('review: not yet implemented');
  });

program
  .command('audit')
  .description('Run final repo-wide verification with Codex CLI')
  .option('--repo <path>', 'Path to target repository')
  .action(() => {
    console.log('audit: not yet implemented');
  });

program
  .command('resume')
  .description('Continue from persisted state')
  .option('--repo <path>', 'Path to target repository')
  .action(() => {
    console.log('resume: not yet implemented');
  });

program
  .command('report')
  .description('Generate markdown report with task history and final status')
  .option('--repo <path>', 'Path to target repository')
  .action(() => {
    console.log('report: not yet implemented');
  });

program.parse(process.argv);
