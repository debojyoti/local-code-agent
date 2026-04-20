#!/usr/bin/env node
import { Command } from 'commander';
import { runDoctor } from '../core/doctor.js';

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
  .option('--repo <path>', 'Path to target repository')
  .option('--spec <path>', 'Path to spec file')
  .action(() => {
    console.log('plan: not yet implemented');
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
  .option('--repo <path>', 'Path to target repository')
  .option('--task <id>', 'Task ID to run')
  .action(() => {
    console.log('run-task: not yet implemented');
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
