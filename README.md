# Local Code Agent

Terminal-first TypeScript orchestrator for planning work with Codex CLI, implementing tasks with Claude Code CLI, and persisting state under `.ai-orchestrator/`.

## What It Does

This tool runs a grounded local workflow:
- Codex reads your repo and project spec, then creates an ordered task plan
- Claude implements one task at a time
- local checks run after each implementation attempt
- Codex reviews the result and either passes it, blocks it, or asks for revisions
- when a task passes, the orchestrator automatically moves to the next task
- prompts, outputs, reviews, logs, and reports are saved under `.ai-orchestrator/`

The normal end-to-end flow is:
1. write a project spec
2. run `plan`
3. optionally run `plan-refine`
4. run `run`
5. if execution stops, run `resume`
6. run `audit` and `report`

## Quick Start

### 1. Install and build

```bash
npm install
npm run build
```

For local development, you can run the CLI directly through `tsx`:

```bash
npm run dev -- --help
```

### 2. Verify your environment

```bash
npm run dev -- doctor --repo /path/to/project
```

This checks:
- `codex` is available on `PATH`
- `claude` is available on `PATH`
- `git` is available on `PATH`
- the target path is inside a git repository

Example:

```bash
npm run dev -- doctor --repo ~/code/my-app
```

### 3. Add the initial project spec

Create `.ai-orchestrator/spec.md` inside the target repo. This is the initial prompt/spec Codex uses during planning.

Use it to describe:
- what you want built
- scope boundaries
- constraints
- what to avoid
- what “done” looks like

Example:

```md
# Project Spec

Build a small local CLI that scans markdown files and generates a JSON summary.

Constraints:
- keep it simple and grounded
- do not add a database
- do not add a web UI
- prefer a single executable entrypoint

Required behavior:
- scan a target folder recursively
- extract title, headings, and word count
- write one summary.json output file
- handle missing files and invalid markdown gracefully

Definition of done:
- CLI accepts an input directory and output file path
- output format is documented
- basic tests cover the parsing flow
```

Default location:

```text
/path/to/project/.ai-orchestrator/spec.md
```

Keep this file short and grounded. It should be a practical product/task spec, not a giant architecture document.

### 4. Generate the first task plan

```bash
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
```

What `plan` does:
- reads `.ai-orchestrator/spec.md`
- inspects the repo shape, recent commits, root `README.md`, and `package.json`
- sends that context to Codex
- asks Codex to break the work into small ordered tasks
- writes the result into `.ai-orchestrator/tasks.json`

Example:

```bash
npm run dev -- plan --repo ~/code/my-app --spec ~/code/my-app/.ai-orchestrator/spec.md
```

This writes:
- `.ai-orchestrator/tasks.json`
- `.ai-orchestrator/config.json`
- planning prompts under `.ai-orchestrator/prompts/`
- planning raw outputs under `.ai-orchestrator/artifacts/`

After planning, inspect:
- `.ai-orchestrator/tasks.json`
- `.ai-orchestrator/config.json`

### 5. Refine the plan with feedback

If the first plan is close but not right, refine it without rewriting the entire spec.

Inline feedback:

```bash
npm run dev -- plan-refine --repo /path/to/project --feedback "Split the storage work into smaller tasks. Keep the architecture simple. Do not add a UI."
```

Feedback from a file:

```bash
npm run dev -- plan-refine --repo /path/to/project --feedback-file /path/to/feedback.md
```

Example `feedback.md`:

```md
Keep the task list grounded.

Feedback on the current plan:
- split auth and session handling into separate tasks
- do not add optional reporting work yet
- prefer modifying existing modules over introducing new layers
- keep database concerns out of scope for now
```

What `plan-refine` does:
- loads the existing `spec.md`
- loads the current `tasks.json`
- loads the latest prior planning artifact if available
- sends all of that plus your feedback to Codex
- writes a revised `tasks.json`
- preserves execution history only for tasks that are effectively unchanged
- updates `config.json` with refined recommended commands when existing values are blank

Use `plan-refine` repeatedly until the task list looks right.

### 6. Execute work automatically

Run the full dependency-aware flow:

```bash
npm run dev -- run --repo /path/to/project
```

This is the automatic mode. You do not need to manually run each task.

What `run` does:
1. loads the ordered tasks from `tasks.json`
2. selects the next runnable task in dependency order
3. builds a task-specific prompt/brief for Claude
4. runs Claude on that task in an isolated detached worktree
5. runs local checks
6. sends the result, diff, and check output to Codex for review
7. if Codex asks for revisions, saves the fix brief and sends the next iteration prompt to Claude
8. repeats until the task is `PASS`, `BLOCKED`, or hits the retry limit
9. moves to the next task automatically when the current one passes

Example:

```bash
npm run dev -- run --repo ~/code/my-app
```

The orchestrator uses a separate git worktree per task, but it does not create a task branch. Claude works in a detached worktree and regular commits are still allowed there.

### 7. Audit and report

```bash
npm run dev -- audit --repo /path/to/project
npm run dev -- report --repo /path/to/project --audit
```

Example:

```bash
npm run dev -- audit --repo ~/code/my-app
npm run dev -- report --repo ~/code/my-app --audit
```

The report step writes human-readable markdown and JSON artifacts under `.ai-orchestrator/reports/`.

### 8. Optional viewer

```bash
npm run dev -- viewer --repo /path/to/project --port 7842
```

Then open `http://127.0.0.1:7842`.

## Full Workflow Example

```bash
npm run dev -- doctor --repo ~/code/my-app
npm run dev -- plan --repo ~/code/my-app --spec ~/code/my-app/.ai-orchestrator/spec.md
npm run dev -- plan-refine --repo ~/code/my-app --feedback "Split the CLI and parser work into separate tasks."
npm run dev -- run --repo ~/code/my-app
npm run dev -- audit --repo ~/code/my-app
npm run dev -- report --repo ~/code/my-app --audit
```

## Resume a Project

If a run stops partway through, resume it with:

```bash
npm run dev -- resume --repo /path/to/project
```

What resume does:
- loads `.ai-orchestrator/state.json`
- reloads `.ai-orchestrator/tasks.json`
- resets tasks stuck in `running` or `reviewing` back to `pending`
- continues in dependency order from persisted task state

Example:

```bash
npm run dev -- resume --repo ~/code/my-app
```

Resume will fail loudly if `state.json` is missing. In that case, start with:

```bash
npm run dev -- run --repo /path/to/project
```

Typical full flow:

```bash
npm run dev -- doctor --repo /path/to/project
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
npm run dev -- run --repo /path/to/project
```

If the run stops:

```bash
npm run dev -- resume --repo /path/to/project
```

## What You See in the Terminal

When you run `plan`, `plan-refine`, `run`, `execute`, `review`, `audit`, or `report`, the terminal shows concise progress:
- which command started
- which task is running
- when Claude or Codex is being invoked
- check names and exit codes
- pass / revise / blocked / failed summaries
- artifact file paths

Detailed raw outputs are persisted to disk instead of being fully dumped into the terminal.

Important saved files:
- Claude outputs under `.ai-orchestrator/artifacts/`
- review outputs under `.ai-orchestrator/reviews/`
- prompts under `.ai-orchestrator/prompts/`
- logs under `.ai-orchestrator/logs/`
- reports under `.ai-orchestrator/reports/`

## Detailed Command Usage

### `doctor`

```bash
npm run dev -- doctor --repo /path/to/project
```

Use this first when setting up a new machine or project.

### `plan`

```bash
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
```

Creates the first ordered task plan.

### `plan-refine`

```bash
npm run dev -- plan-refine --repo /path/to/project --feedback "Make the tasks smaller and keep the design simple."
```

Use this after reviewing `tasks.json`.

### `run`

```bash
npm run dev -- run --repo /path/to/project
```

Runs all pending tasks automatically in dependency order.

### `resume`

```bash
npm run dev -- resume --repo /path/to/project
```

Continues a previously started run.

### `run-task`

```bash
npm run dev -- run-task --repo /path/to/project --task TASK-001
```

Runs one implementation pass only. This does not include the full revise loop.

### `review`

```bash
npm run dev -- review --repo /path/to/project --task TASK-001
```

Runs Codex review for an already executed task.

### `execute`

```bash
npm run dev -- execute --repo /path/to/project --task TASK-001
```

Runs one task through the full Claude -> checks -> Codex review -> revise loop.

### `audit`

```bash
npm run dev -- audit --repo /path/to/project
```

Runs a repo-wide final Codex audit.

### `report`

```bash
npm run dev -- report --repo /path/to/project
npm run dev -- report --repo /path/to/project --audit
```

Generates the final markdown and JSON report. With `--audit`, it runs audit first.

### `viewer`

```bash
npm run dev -- viewer --repo /path/to/project --port 7842
```

Starts a read-only local viewer.

## Common Usage Patterns

### New project

```bash
mkdir -p /path/to/project/.ai-orchestrator
$EDITOR /path/to/project/.ai-orchestrator/spec.md
npm run dev -- doctor --repo /path/to/project
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
npm run dev -- run --repo /path/to/project
```

### Refine the plan before execution

```bash
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
cat /path/to/project/.ai-orchestrator/tasks.json
npm run dev -- plan-refine --repo /path/to/project --feedback "Split the API and persistence work into separate tasks."
```

### Resume after interruption

```bash
npm run dev -- run --repo /path/to/project
# run stops midway
npm run dev -- resume --repo /path/to/project
```

### Debug one task only

```bash
npm run dev -- execute --repo /path/to/project --task TASK-003
```

## Useful Commands

```bash
npm run dev -- doctor --repo /path/to/project
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
npm run dev -- plan-refine --repo /path/to/project --feedback "Keep tasks grounded."
npm run dev -- run --repo /path/to/project
npm run dev -- resume --repo /path/to/project
npm run dev -- run-task --repo /path/to/project --task TASK-001
npm run dev -- review --repo /path/to/project --task TASK-001
npm run dev -- execute --repo /path/to/project --task TASK-001
npm run dev -- audit --repo /path/to/project
npm run dev -- report --repo /path/to/project --audit
npm run dev -- viewer --repo /path/to/project --port 7842
```

## State Layout

The target repo stores orchestrator state here:

```text
.ai-orchestrator/
  config.json
  state.json
  tasks.json
  prompts/
  artifacts/
  reviews/
  reports/
  worktrees/
```

Typical files you will inspect most often:
- `spec.md`: your initial project prompt/spec
- `tasks.json`: the current plan
- `config.json`: inferred or preserved lint/test/typecheck commands
- `state.json`: current orchestration state

Keep the workflow grounded:
- start with a narrow spec
- run one project at a time
- inspect `tasks.json`, review artifacts, and reports instead of adding more abstraction
- prefer fixing a bad task or prompt over adding more orchestration logic
