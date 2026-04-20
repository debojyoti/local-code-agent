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

## Multi-Repo Workspace

Everything above assumes a single git repository. The orchestrator also supports a **workspace root** that sits above several git repos — one `.ai-orchestrator/` directory at the workspace root coordinates tasks across those repos.

Single-repo usage is unchanged. Workspace mode is additive.

### When to point `--repo` at a workspace root vs a single repo

- Single repo: pass `--repo /path/to/repo` — the same path that contains your git checkout. This is the normal mode.
- Workspace: pass `--repo /path/to/workspace` — the directory that contains `.ai-orchestrator/` and **multiple** child git repos. The workspace root itself does not need to be a git repo.

The CLI auto-detects workspace mode by looking for `.ai-orchestrator/repos.json` under the `--repo` path. If present, the orchestrator treats that path as a workspace root.

### Workspace layout

```text
/path/to/workspace/
  .ai-orchestrator/
    spec.md
    repos.json          # declares child repos
    tasks.json          # one shared, ordered task list spanning all repos
    config.json
    state.json
    prompts/
    artifacts/
    reviews/
    reports/
    worktrees/          # per-task worktrees, still rooted at the workspace
  frontend/             # child git repo
    .git/
    ...
  backend/              # child git repo
    .git/
    ...
```

All state and artifacts stay under the workspace root. Per-task worktrees live under `workspace/.ai-orchestrator/worktrees/<TASK-ID>/` but are created from the correct child repo based on the task's `repo_id`.

### `.ai-orchestrator/repos.json`

Declare each child repo with an `id`, a `path` (relative to the workspace root or absolute), and an optional `description`.

```json
{
  "version": "1",
  "repos": [
    { "id": "frontend", "path": "./frontend", "description": "Next.js web app" },
    { "id": "backend",  "path": "./backend",  "description": "Go API service" }
  ]
}
```

- `id` is the value tasks use to target a repo. Keep it short and stable.
- `path` may be relative (resolved against the workspace root) or absolute.
- Each declared path must be an actual git repository — `doctor` validates this.

### Workspace `spec.md`

Write the spec at the workspace level. Reference the child repos by their `id`s so Codex can split work across them.

```md
# Workspace Spec

Goal: add end-to-end "delete account" flow across the web app and the API.

Repositories:
- frontend — Next.js web app
- backend — Go API service

Required behavior:
- backend: new DELETE /v1/account endpoint, soft-delete the row, return 204
- frontend: add a confirmation dialog on the account settings page; call the endpoint; surface errors inline
- both: cover the new behavior with a small test

Constraints:
- keep the migration reversible
- no new dependencies in frontend
- do not change unrelated routes or pages

Definition of done:
- the endpoint, UI, and tests land in their respective repos
- a manual click-through from settings deletes the test account and returns to the sign-in screen
```

Keep it practical and grounded. Do not dump architecture diagrams — the planner already inspects each repo's shape.

### `doctor` in workspace mode

```bash
npm run dev -- doctor --repo /path/to/workspace
```

`doctor` detects the workspace, prints each declared repo, and reports per-repo issues (missing path, not a git repository, etc.) alongside the usual tool checks.

### Planning a workspace

```bash
npm run dev -- plan --repo /path/to/workspace --spec /path/to/workspace/.ai-orchestrator/spec.md
```

What changes in workspace mode:
- the planner inspects **each** declared repo (git log, top-level items, `package.json`, `README.md`) and includes a per-repo section in the planning prompt
- Codex is instructed that every task must include a `repo_id` from the declared list
- tasks.json ends up with one shared ordered list — each task carries a `repo_id` identifying its target repo

If Codex omits a `repo_id` on any task, planning fails loudly and you can retry. If a task references an unknown `repo_id`, it fails the same way.

### Refining a workspace plan

```bash
npm run dev -- plan-refine --repo /path/to/workspace --feedback "Move the migration into its own task under backend before the endpoint task."
```

`plan-refine` behaves the same as single-repo — it replays the workspace planning context plus your feedback. Preserved history still follows unchanged tasks.

### Running and resuming a workspace

Run from the workspace root:

```bash
npm run dev -- run --repo /path/to/workspace
```

What happens:
- `tasks.json` remains the single ordering source — dependencies are honored across repos (a task in `backend` can depend on a task in `frontend`, or vice versa)
- each task's worktree is created from the repo identified by its `repo_id`
- Claude runs in the correct repo's worktree; local checks run there too
- Codex reviews the task with the correct repo as its working directory
- artifacts, logs, state, and reports stay centralized under the workspace root

Terminal output includes `[repo_id]` next to the task id/title on skip lines, task headers, stop-on-blocked/failed lines, and the resume reset line — so you always know which repo a given task belongs to.

Resume from the same workspace path:

```bash
npm run dev -- resume --repo /path/to/workspace
```

Resume still:
- reads `state.json` from the workspace root
- resets any task stuck in `running` or `reviewing` back to `pending` before continuing
- continues dependency-aware execution across repos from the persisted state

### Per-task commands in workspace mode

`run-task`, `review`, and `execute` all accept the workspace root. They resolve the correct child repo from the task's `repo_id` automatically.

```bash
npm run dev -- run-task --repo /path/to/workspace --task TASK-002
npm run dev -- review   --repo /path/to/workspace --task TASK-002
npm run dev -- execute  --repo /path/to/workspace --task TASK-002
```

If a task has a `repo_id` that isn't declared in `repos.json`, the command fails before creating a worktree or invoking Codex.

### `audit`, `report`, and `viewer` in workspace mode

Audit and report both detect the workspace and add repo context without becoming noisy.

```bash
npm run dev -- audit  --repo /path/to/workspace
npm run dev -- report --repo /path/to/workspace --audit
```

- the audit prompt gains a `## Workspace` block listing each declared repo and a `Repo` column in the Task Results table
- the markdown report gains a `## Repositories` summary (task counts per repo) and tags each per-task section with `[repo_id]`; the root is labeled `Workspace root:` instead of `Repository:`
- `final-report.json` → `task_summaries[i].repo_id` is populated for workspace tasks

The viewer shows a `Repo` column in the task list whenever any task carries a `repo_id`, and the task detail page surfaces the `Repo:` line near the status:

```bash
npm run dev -- viewer --repo /path/to/workspace --port 7842
```

### Where `repo_id` shows up

- `tasks.json` — every task in workspace mode has a `repo_id` field
- terminal output — `run`, `resume`, `run-task`, `review`, and `execute` print `[repo_id]` next to the task id
- `reports/report.md` — Repositories summary, per-task section headings and bullet, final report JSON `task_summaries[i].repo_id`
- `reports/audit-prompt.md` — `## Workspace` section and Repo column in the task table
- viewer — Repo column in the overview, `Repo: <id>` line on the task detail page

### Full workspace example

```bash
mkdir -p /path/to/workspace/.ai-orchestrator
$EDITOR /path/to/workspace/.ai-orchestrator/spec.md
$EDITOR /path/to/workspace/.ai-orchestrator/repos.json
npm run dev -- doctor --repo /path/to/workspace
npm run dev -- plan   --repo /path/to/workspace --spec /path/to/workspace/.ai-orchestrator/spec.md
cat /path/to/workspace/.ai-orchestrator/tasks.json
npm run dev -- plan-refine --repo /path/to/workspace --feedback "Land the backend endpoint before the frontend dialog."
npm run dev -- run    --repo /path/to/workspace
# if execution stops:
npm run dev -- resume --repo /path/to/workspace
npm run dev -- report --repo /path/to/workspace --audit
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

The target repo (or workspace root) stores orchestrator state here:

```text
.ai-orchestrator/
  config.json
  state.json
  tasks.json
  repos.json          # workspace mode only
  prompts/
  artifacts/
  reviews/
  reports/
  worktrees/
```

Typical files you will inspect most often:
- `spec.md`: your initial project prompt/spec
- `tasks.json`: the current plan (tasks carry a `repo_id` in workspace mode)
- `repos.json`: declared child repos — present only in workspace mode
- `config.json`: inferred or preserved lint/test/typecheck commands
- `state.json`: current orchestration state

Keep the workflow grounded:
- start with a narrow spec
- run one project at a time
- inspect `tasks.json`, review artifacts, and reports instead of adding more abstraction
- prefer fixing a bad task or prompt over adding more orchestration logic
