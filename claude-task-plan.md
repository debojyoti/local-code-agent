# Claude Build Plan

This file turns [plan.md](/home/debojyoti/projects/local-code-agent/plan.md) into small implementation steps you can hand to Claude one by one.

## How To Use This

For each step:

1. Copy the `Claude prompt` for that step and give it to Claude.
2. Let Claude implement only that step.
3. Come back here and ask me to review the result.
4. I will do one of two things:
   - give you a fix prompt if the step is not aligned
   - give you the next step prompt if the step is good

Ground rules for every step:

- Keep it grounded in the existing repo and the current phase.
- Do not overcomplicate the architecture.
- Do not add speculative abstractions for future phases.
- Do not build the browser viewer until the terminal flow works.
- Prefer simple, typed, inspectable local code.
- Avoid unrelated refactors.

## Shared Instruction Prefix

Use this prefix at the top of every Claude prompt:

```md
You are implementing one small phase of a local TypeScript CLI orchestrator based on `plan.md`.

Keep the work grounded and do not overcomplicate it.
Do only the work requested in this step.
Do not add speculative abstractions for future phases.
Do not build optional UI or viewer code unless the step explicitly asks for it.
Prefer clear, simple modules over clever patterns.
Avoid unrelated refactors.

At the end, give:
1. A short summary of what changed
2. The exact files created or modified
3. Any assumptions or open issues
```

## Step 1

Goal: scaffold the TypeScript CLI project and basic folder structure.

Claude prompt:

```md
You are implementing Step 1 from `claude-task-plan.md`.

Set up the project scaffold for a local TypeScript CLI orchestrator described in `plan.md`.

Requirements:
- Initialize a practical Node.js + TypeScript project structure
- Add a minimal package.json with only necessary dependencies
- Add tsconfig.json
- Add a sensible src folder layout aligned with `plan.md`
- Add a CLI entrypoint placeholder
- Add npm scripts for build, dev, typecheck, lint, and test placeholders if appropriate
- Do not implement business logic yet
- Do not add optional viewer code
- Keep the setup simple and grounded

Deliverable:
- A repo scaffold that is ready for actual implementation in the next step
```

Review focus:

- Is the scaffold minimal and usable?
- Did Claude avoid premature abstractions?
- Are dependencies reasonable?
- Is the folder layout aligned with `plan.md`?

## Step 2

Goal: implement `orchestrator doctor` with real local checks.

Claude prompt:

```md
You are implementing Step 2 from `claude-task-plan.md`.

Implement the `orchestrator doctor` command for the TypeScript CLI scaffold.

Requirements:
- Check whether `codex`, `claude`, and `git` CLIs are available on PATH
- Validate that the current repo or provided repo path looks like a git repository
- Print clear, actionable diagnostics
- Return a failing exit code when critical checks fail
- Keep output terminal-first and simple
- Structure the implementation so command execution logic can be reused later
- Do not implement planning or task execution yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A working `doctor` command with straightforward diagnostics
```

Review focus:

- Does it actually validate the required tools?
- Are failures clear and actionable?
- Is the command runner reusable without being overdesigned?

## Step 3

Goal: add schemas and persisted orchestrator state foundations.

Claude prompt:

```md
You are implementing Step 3 from `claude-task-plan.md`.

Implement the core schemas and persistence foundations described in `plan.md`.

Requirements:
- Add typed schemas for config, task, task list, state, execution result, and review result
- Use zod for validation
- Add simple read/write helpers for `.ai-orchestrator/` state files
- Handle missing files cleanly
- Keep schema shapes aligned with `plan.md`
- Do not build the full runtime loop yet
- Do not add complex repository abstractions
- Keep it grounded and not overcomplicated

Deliverable:
- Reusable schema and persistence modules that later commands can build on
```

Review focus:

- Are the schemas aligned with the spec?
- Is persistence simple and reliable?
- Did Claude avoid encoding too much future behavior into the state layer?

## Step 4

Goal: implement git worktree helpers and diff helpers.

Claude prompt:

```md
You are implementing Step 4 from `claude-task-plan.md`.

Implement the git helper layer needed by `plan.md`.

Requirements:
- Add helpers for creating a task worktree
- Add helpers for removing a task worktree
- Add helpers for listing changed files and getting a diff
- Keep branch and worktree naming deterministic
- Keep the implementation pragmatic and easy to inspect
- Do not implement the full task runner yet
- Do not add merge automation yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A small git helper module that supports later task execution work
```

Review focus:

- Are worktree paths and branch names predictable?
- Are git operations isolated and safe?
- Is the helper layer small and understandable?

## Step 5

Goal: implement artifact persistence for prompts, logs, outputs, and reviews.

Claude prompt:

```md
You are implementing Step 5 from `claude-task-plan.md`.

Implement artifact persistence under `.ai-orchestrator/` as described in `plan.md`.

Requirements:
- Persist prompt artifacts, command outputs, logs, reviews, and reports in clear folders
- Use timestamped or otherwise deterministic filenames where appropriate
- Make artifact paths easy to trace from terminal output
- Keep file writing logic simple and reliable
- Do not add viewer code
- Do not overdesign a storage abstraction
- Keep it grounded and not overcomplicated

Deliverable:
- A practical artifact writer/reader layer the rest of the system can use
```

Review focus:

- Are artifact locations clear and consistent?
- Will this be easy to debug during runs?
- Is the design simple enough for a local CLI tool?

## Step 6

Goal: implement `orchestrator plan` using Codex CLI and save normalized tasks.

Claude prompt:

```md
You are implementing Step 6 from `claude-task-plan.md`.

Implement the `orchestrator plan --repo <path> --spec <path>` flow.

Requirements:
- Read the spec file
- Inspect the target repo at a practical level
- Build a prompt for Codex CLI to generate ordered tasks
- Execute Codex CLI locally through the runner abstraction
- Save the raw planning output as an artifact
- Normalize and validate tasks into `tasks.json`
- Print a concise terminal summary of the plan
- Keep parsing pragmatic and robust
- Do not start task execution yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A usable planning command that produces saved tasks for later execution
```

Review focus:

- Does it save both raw and normalized outputs?
- Are tasks validated properly?
- Is the planning prompt concise and deterministic enough?

## Step 7

Goal: implement single-task execution with Claude Code CLI.

Claude prompt:

```md
You are implementing Step 7 from `claude-task-plan.md`.

Implement `orchestrator run-task --repo <path> --task <TASK-ID>` for a single task execution pass.

Requirements:
- Load task data from persisted state
- Create or reuse the task worktree
- Generate and save the Claude implementation brief
- Invoke Claude Code CLI for only that task
- Capture stdout, stderr, exit code, changed files, and diff
- Persist execution artifacts and update task state
- Do not implement the review loop yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A single-task execution flow that can run Claude and capture results cleanly
```

Review focus:

- Is task isolation working?
- Are artifacts and state updates complete?
- Is the implementation brief scoped to one task only?

## Step 8

Goal: add local lint/test/typecheck execution after task implementation.

Claude prompt:

```md
You are implementing Step 8 from `claude-task-plan.md`.

Extend single-task execution to run mandatory local checks after Claude finishes.

Requirements:
- Run lint, test, and typecheck commands in the task worktree
- Capture their outputs and exit codes
- Persist those results as artifacts
- Reflect check results in task execution state
- Keep command handling straightforward
- Do not implement retry or Codex review yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- Single-task execution now includes local verification artifacts
```

Review focus:

- Are checks run in the correct worktree?
- Are results captured in a reusable format?
- Does failure handling stay simple and explicit?

## Step 9

Goal: implement Codex review for one completed task.

Claude prompt:

```md
You are implementing Step 9 from `claude-task-plan.md`.

Implement `orchestrator review --repo <path> --task <TASK-ID>` for a single completed task.

Requirements:
- Load the original task, acceptance criteria, implementation brief, diff, changed files, and check outputs
- Build a structured Codex review prompt
- Invoke Codex CLI locally
- Persist the raw review output
- Parse and validate a structured review result with verdict, summary, checklist, issues, fix brief, and confidence
- Update task state based on the verdict
- Keep parsing pragmatic and resilient
- Do not implement automatic retry yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A usable single-task review command with persisted review results
```

Review focus:

- Is the review input complete?
- Is the parsed verdict reliable enough to drive the loop?
- Are verdict transitions aligned with the spec?

## Step 10

Goal: add revise loop and retry handling for one task.

Claude prompt:

```md
You are implementing Step 10 from `claude-task-plan.md`.

Add the review-driven revise loop for a single task.

Requirements:
- If Codex returns REVISE, save the fix brief
- Re-run Claude in the same task context using the fix brief
- Re-run local checks
- Re-run Codex review
- Stop at PASS, BLOCKED, or retry limit
- Persist each attempt clearly
- Keep retry logic explicit and inspectable
- Do not implement full repo run ordering yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A robust single-task execution + review loop with retry handling
```

Review focus:

- Is retry state persisted cleanly?
- Are attempts traceable?
- Did Claude avoid turning this into a generic workflow engine?

## Step 11

Goal: implement full ordered execution and resume support.

Claude prompt:

```md
You are implementing Step 11 from `claude-task-plan.md`.

Implement `orchestrator run --repo <path>` and `orchestrator resume --repo <path>`.

Requirements:
- Run tasks in dependency-aware or defined order from `tasks.json`
- Reuse the existing single-task loop
- Stop on BLOCKED or unrecoverable failure unless config says otherwise
- Persist enough state to resume safely
- Print concise terminal progress and summaries
- Keep control flow understandable
- Do not add optional viewer code
- Keep it grounded and do not overcomplicate it

Deliverable:
- End-to-end ordered task execution with resumability
```

Review focus:

- Can a stopped run resume safely?
- Are task transitions coherent across multiple tasks?
- Is the orchestration logic still readable?

## Step 12

Goal: final audit and markdown reporting.

Claude prompt:

```md
You are implementing Step 12 from `claude-task-plan.md`.

Implement `orchestrator audit --repo <path>` and `orchestrator report --repo <path>`.

Requirements:
- Add a final Codex repo-wide audit flow
- Persist audit prompts and outputs
- Generate a human-readable markdown report with task history, retries, verdicts, and final status
- Keep report generation straightforward
- Keep terminal summaries concise
- Do not add optional viewer code in this step
- Keep it grounded and do not overcomplicate it

Deliverable:
- A practical final audit and report flow for the orchestrator
```

Review focus:

- Is the audit using the right artifacts and context?
- Is the markdown report useful without being noisy?
- Does the implementation stay pragmatic?

## Step 13

Goal: optional read-only viewer, only if the terminal flow is already solid.

Claude prompt:

```md
You are implementing Step 13 from `claude-task-plan.md`.

Only do this step if the terminal-first workflow is already working end to end.

Implement a very lightweight read-only local viewer.

Requirements:
- Show task list and statuses
- Show current task details
- Show latest artifacts such as briefs, reviews, diffs, and reports
- Keep it read-only
- Keep the implementation minimal
- Do not redesign core architecture around the viewer
- Keep it grounded and do not overcomplicate it

Deliverable:
- A basic optional viewer that sits on top of the existing terminal-first system
```

Review focus:

- Was this added only after the terminal flow was solid?
- Is the viewer read-only and lightweight?
- Did Claude avoid letting the viewer distort the core architecture?

## Step 14

Goal: add explicit workspace support without changing execution yet.

Claude prompt:

```md
You are implementing Step 14 from `claude-task-plan.md`.

Add a grounded workspace model so the orchestrator can target a directory that contains multiple git repos.

Requirements:
- Add a simple workspace manifest such as `.ai-orchestrator/repos.json`
- Support a workspace root that is not itself a git repository
- Extend `doctor` so it can validate either:
  - a single repo path
  - or a workspace root containing multiple child repos
- Print clear diagnostics for detected repos and missing repos
- Keep single-repo behavior working
- Do not change task execution yet
- Do not implement cross-repo planning yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A minimal workspace foundation and doctor support for multi-repo projects
```

Review focus:

- Is the workspace model explicit and small?
- Does `doctor` clearly handle both single-repo and workspace-root paths?
- Did Claude avoid prematurely changing executor/planner logic?

## Step 15

Goal: add multi-repo-aware schemas and task metadata.

Claude prompt:

```md
You are implementing Step 15 from `claude-task-plan.md`.

Extend the orchestrator state and task model to support tasks that belong to different repos inside one workspace.

Requirements:
- Add a `repo_id` field to tasks
- Add typed schema support for the workspace manifest and repo entries
- Keep one top-level `tasks.json` for orchestration order
- Keep backwards compatibility for single-repo mode where practical
- Add path helpers for resolving a task's target repo from `repo_id`
- Do not change the planner prompt yet
- Do not change executor behavior yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A clean schema/state layer that can represent single-repo and multi-repo tasks
```

Review focus:

- Is `repo_id` integrated cleanly?
- Does the model stay simple?
- Is single-repo behavior still supported?

## Step 16

Goal: make planning workspace-aware and let Codex generate tasks across repos.

Claude prompt:

```md
You are implementing Step 16 from `claude-task-plan.md`.

Extend planning so Codex can analyze a workspace root containing multiple repos and generate tasks for multiple repos.

Requirements:
- Inspect each declared repo in the workspace manifest
- Build a planning prompt that includes per-repo context
- Make it explicit to Codex that each task must include `repo_id`
- Save normalized tasks with `repo_id` into the shared `tasks.json`
- Keep task ordering and dependency handling straightforward
- Keep single-repo planning working
- Do not change execution yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- A planning flow that can produce a shared multi-repo task list
```

Review focus:

- Is repo context clearly separated in the planning prompt?
- Are planned tasks validated with `repo_id`?
- Did Claude avoid creating an overly abstract planner framework?

## Step 17

Goal: make single-task execution repo-aware.

Claude prompt:

```md
You are implementing Step 17 from `claude-task-plan.md`.

Extend single-task execution so each task runs in the repo identified by its `repo_id`.

Requirements:
- Resolve the task's target repo from the workspace manifest
- Create the worktree in the correct repo
- Run Claude in the correct repo worktree
- Run local checks using the correct repo context
- Keep artifact/state storage centralized under the workspace root
- Keep single-repo execution working
- Do not change full orchestration yet
- Keep it grounded and do not overcomplicate it

Deliverable:
- Repo-aware `run-task` and single-task execute/review support
```

Review focus:

- Does task execution happen in the correct repo?
- Are artifacts still traceable from the workspace root?
- Is the repo-resolution logic explicit and easy to inspect?

## Step 18

Goal: make full orchestration and resume work across repos.

Claude prompt:

```md
You are implementing Step 18 from `claude-task-plan.md`.

Extend full orchestration so `run` and `resume` can execute tasks across multiple repos in one workspace.

Requirements:
- Reuse the existing single-task loop
- Respect task dependencies across repos
- Keep one shared top-level orchestration state under the workspace root
- Ensure resume still resets stuck tasks safely
- Print clear terminal summaries that include each task's `repo_id`
- Keep single-repo orchestration working
- Do not redesign the control flow into a generic workflow engine
- Keep it grounded and do not overcomplicate it

Deliverable:
- End-to-end multi-repo run/resume support
```

Review focus:

- Does orchestration remain readable after adding multi-repo support?
- Are dependency checks still deterministic across repos?
- Is resume safe and conservative?

## Step 19

Goal: make audit, report, and viewer workspace-aware.

Claude prompt:

```md
You are implementing Step 19 from `claude-task-plan.md`.

Extend audit, report, and the optional viewer so they work cleanly for a multi-repo workspace.

Requirements:
- Include `repo_id` in report output where relevant
- Make audit prompts aware of multiple repos
- Keep reports human-readable and not too noisy
- Update the optional viewer to show which repo each task belongs to
- Keep artifacts and summaries rooted at the workspace level
- Preserve single-repo behavior
- Keep it grounded and do not overcomplicate it

Deliverable:
- Workspace-aware audit/report/viewer support
```

Review focus:

- Are reports still readable after adding repo context?
- Does audit use the right workspace artifacts?
- Is the viewer still lightweight?

## Step 20

Goal: document workspace and multi-repo usage thoroughly.

Claude prompt:

```md
You are implementing Step 20 from `claude-task-plan.md`.

Update the documentation for workspace and multi-repo usage.

Requirements:
- Add README guidance for:
  - workspace roots
  - `.ai-orchestrator/repos.json`
  - multi-repo planning
  - multi-repo execution and resume
- Include concrete examples
- Keep the docs practical and terminal-first
- Do not add speculative future architecture notes
- Keep it grounded and do not overcomplicate it

Deliverable:
- Clear docs for using the orchestrator across multiple repos
```

Review focus:

- Can a user follow the docs without guessing?
- Are the examples aligned with the implemented behavior?
- Did Claude keep the docs practical rather than theoretical?

## What To Send Me After Each Step

Send me:

- the step number
- the diff or changed files
- any command results Claude used for validation

I will then either:

- give you a fix prompt for Claude
- or give you the exact next-step prompt to send Claude
