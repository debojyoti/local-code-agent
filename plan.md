# Build a Local AI Coding Orchestrator Using Codex CLI + Claude Code CLI

You are building a production-quality local developer tool.

## Core Goal

Build a terminal-first local orchestrator that coordinates:

- Codex CLI as the planner, reviewer, and final gatekeeper
- Claude Code CLI as the code implementer
- Local git worktrees for task isolation
- Local filesystem state for resumability
- Local command execution for lint/test/typecheck
- Optional lightweight browser viewer for visibility
- No OpenAI API calls
- No Anthropic API calls
- No editor plugin assumptions
- No cloud orchestration dependency

This system must work by shelling out to the installed CLIs on the user's machine.

---

## Product Summary

The user wants to run one local command and have the system:

1. Load a repo
2. Read a master spec
3. Ask Codex CLI to analyze the codebase and produce ordered tasks
4. Execute tasks one by one in isolated git worktrees
5. For each task:
   - ask Codex CLI to produce a precise implementation brief for Claude
   - invoke Claude Code CLI to implement the task
   - run lint, tests, and typecheck locally
   - ask Codex CLI to review Claude's output using the diff and command results
   - if Codex says revise, repeat with a new fix brief
6. After all tasks pass, ask Codex CLI to perform a deep final verification
7. Produce a final human-readable report

The system must be observable, resumable, and safe.

---

## Important Constraints

- Use CLI tools only
- Do not use model APIs
- Assume Codex CLI and Claude Code CLI are already installed or can be validated at startup
- Build for macOS/Linux first
- Keep architecture modular
- Prioritize correctness and debuggability over flashy UI
- The terminal workflow is the primary UX
- A browser viewer is secondary and optional
- Use structured files, not prompt copy-paste
- The orchestrator itself must run locally

---

## Recommended Tech Stack

Build with Node.js + TypeScript.

Suggested stack:

- Node.js
- TypeScript
- execa for running CLI commands
- simple-git for git helpers
- zod for schema validation
- pino for logs
- fs/promises for state persistence
- commander or yargs for CLI commands
- optional express for local viewer
- optional ws or socket.io for streaming status to viewer

Do not overengineer.

---

## Required Architecture

Create a monorepo or a single repo with a clean folder structure.

Suggested structure:

/src
  /cli
  /core
  /providers
  /git
  /state
  /review
  /executor
  /planner
  /reporting
  /viewer
/schemas
/templates
/examples
.ai-orchestrator

The orchestrator will also create runtime state inside the target project:

.ai-orchestrator/
  spec.md
  config.json
  state.json
  tasks.json
  runs/
  logs/
  prompts/
  reviews/
  artifacts/
  reports/

If a worktree strategy is used, use something like:

.ai-orchestrator/worktrees/TASK-001
.ai-orchestrator/worktrees/TASK-002

---

## Operating Model

### Roles

Codex CLI:
- analyze repository
- create ordered task plan
- define acceptance criteria
- generate Claude implementation brief per task
- review task output
- decide PASS / REVISE / BLOCKED
- generate fix brief if needed
- perform final deep verification

Claude Code CLI:
- implement exactly one task at a time
- only edit allowed files
- run task-specific commands if instructed
- summarize changes clearly at the end

The orchestrator:
- manage task state
- manage git worktrees
- run CLI commands
- run lint/test/typecheck
- capture diffs
- persist logs and artifacts
- handle retries and resume
- render progress to terminal
- optionally expose read-only local viewer

---

## Required CLI Commands For This Project

Build the orchestrator with these commands:

- orchestrator init
- orchestrator doctor
- orchestrator plan --repo <path> --spec <path>
- orchestrator run --repo <path>
- orchestrator run-task --repo <path> --task <TASK-ID>
- orchestrator review --repo <path> --task <TASK-ID>
- orchestrator audit --repo <path>
- orchestrator resume --repo <path>
- orchestrator report --repo <path>
- orchestrator viewer --repo <path>

Behavior expectations:

### orchestrator init
- initialize local config and templates

### orchestrator doctor
- verify codex CLI exists
- verify claude CLI exists
- verify git exists
- verify repo is valid
- verify default commands can run
- print actionable diagnostics

### orchestrator plan
- read spec
- inspect repo
- ask Codex CLI to generate a task plan
- save normalized tasks.json
- save raw planning output
- show task summary

### orchestrator run
- run all pending tasks in order
- create isolated worktree per task
- keep clear status transitions
- stop on blocked tasks unless configured otherwise

### orchestrator run-task
- run one task only

### orchestrator review
- rerun Codex review for an existing task using saved artifacts

### orchestrator audit
- do final repo-wide verification with Codex CLI

### orchestrator resume
- continue from persisted state

### orchestrator report
- generate markdown report with task history, retries, and final status

### orchestrator viewer
- optional local UI for visibility into tasks/logs/diffs

---

## Required State Model

Create strong schemas for:

1. config.json
2. tasks.json
3. state.json
4. execution-result.json
5. review-result.json
6. final-report.json

### Example task schema

Each task should include:

- id
- title
- goal
- status
- priority
- allowed_files
- acceptance_criteria
- implementation_notes
- test_commands
- retry_count
- max_retries
- created_at
- updated_at
- dependencies

### Allowed task statuses

- pending
- planning
- ready
- running
- reviewing
- revise
- passed
- blocked
- failed

Use zod for validation.

---

## Required Execution Loop

For each task:

1. Create or reuse a dedicated git worktree
2. Ask Codex CLI to produce an implementation brief for Claude
3. Save that brief as markdown artifact
4. Invoke Claude Code CLI in the task worktree with the brief
5. Capture:
   - stdout
   - stderr
   - exit code
   - changed files
   - git diff
6. Run mandatory checks:
   - lint
   - tests
   - typecheck
7. Ask Codex CLI to review:
   - original task
   - acceptance criteria
   - implementation brief
   - changed files
   - diff
   - test/lint/typecheck outputs
8. Parse Codex verdict:
   - PASS
   - REVISE
   - BLOCKED
9. If REVISE:
   - save review
   - generate fix brief
   - re-run Claude
10. Repeat until PASS or retry limit reached

Default retry limit: 3

The orchestrator must never rely on vague freeform memory. Every loop step should be backed by saved artifacts.

---

## Required Safety Rules

Enforce these:

- Claude should only touch files allowed by the task
- The orchestrator should detect unrelated file edits
- Mandatory checks must run outside the model
- Every task must have a worktree or isolated branch context
- Every passed task should optionally create a commit
- Final audit must happen before merge recommendation
- The system must support dry-run mode
- The system must fail clearly and recover cleanly

---

## Git Strategy

Use git worktrees if possible.

Requirements:

- each task gets an isolated worktree
- each task gets its own branch
- diffs are easy to inspect
- failed tasks can be discarded safely
- passed tasks can be committed independently

Build helpers for:

- createWorktree(taskId)
- removeWorktree(taskId)
- getChangedFiles(taskId)
- getDiff(taskId)
- commitTask(taskId)
- mergeOrSummarize(taskId)

---

## Prompt Artifact Strategy

Do not pass giant blobs around casually.

Persist artifacts such as:

- planning prompt
- Codex planning output
- Claude implementation brief
- Claude execution summary
- command outputs
- Codex review prompt
- Codex review output
- final audit prompt
- final audit output

Each should be saved under .ai-orchestrator with timestamps.

---

## Prompt Templates Required

Create reusable prompt templates for:

1. repo analysis and task planning
2. task implementation brief for Claude
3. Codex review prompt
4. Codex final audit prompt

Each template must be concise, structured, and deterministic.

### Planning prompt goals
- understand repo
- identify likely architecture
- break work into ordered tasks
- define acceptance criteria
- define allowed files
- define dependencies
- propose test commands if inferable

### Claude implementation prompt goals
- solve one task only
- respect allowed files
- meet acceptance criteria
- avoid unrelated refactors
- summarize changes

### Codex review prompt goals
- evaluate against task and acceptance criteria
- examine diff and command outputs
- return structured verdict
- produce actionable fix brief if needed

### Final audit prompt goals
- repo-wide deep verification
- architecture consistency
- regression risks
- missing edge cases
- final summary

---

## Required Output Contracts

The orchestrator must be able to parse model outputs.

Require structured sections or JSON blocks from Codex where possible.

### Codex review output must contain:
- verdict
- summary
- acceptance_checklist
- issues_found
- fix_brief
- confidence

### Codex planning output must contain:
- repo_summary
- assumptions
- tasks
- recommended_commands
- risks

If raw output is messy, build robust extractors and validators.

---

## Terminal UX Requirements

Primary UX is terminal-first.

Need:

- clear startup diagnostics
- current task banner
- live step logs
- concise success/failure markers
- artifact paths printed
- retry count shown
- final summary shown

Make terminal output pleasant but not flashy.

---

## Optional Viewer

Build a very lightweight local browser viewer only after terminal flow works.

Viewer can show:

- current repo
- task list and statuses
- current task details
- latest Claude brief
- latest Codex review
- diffs
- test outputs
- final report

Keep it read-only at first.

---

## Required Development Order

Build in this order:

### Phase 1
- project scaffolding
- doctor command
- config and state schemas
- CLI runner abstraction
- git helpers
- artifact persistence

### Phase 2
- planning flow with Codex CLI
- tasks.json generation
- terminal plan summary

### Phase 3
- single-task execution with Claude Code CLI
- lint/test/typecheck execution
- diff capture

### Phase 4
- Codex review loop
- retry handling
- task state transitions

### Phase 5
- run all tasks
- resume support
- final audit
- markdown report generation

### Phase 6
- optional read-only viewer

Do not skip straight to the viewer.

---

## Implementation Quality Bar

This is not a prototype script. Build it cleanly.

Requirements:

- modular architecture
- strong typing
- clear errors
- logs written to disk
- unit tests for core state/parsing logic
- readable code
- minimal dependencies
- no dead code
- no unnecessary abstraction

---

## What To Do Right Now

Start by:

1. scaffolding the repo
2. implementing doctor
3. implementing config/state/task schemas
4. implementing CLI process runner abstraction
5. implementing git worktree helpers
6. implementing artifact persistence
7. implementing Codex planning flow
8. stopping and summarizing progress

After that, continue in phases until the system is usable end to end.

---

## Important Behavioral Rules For The Agent

- Think in terms of buildable increments
- Keep commands explicit
- Do not introduce APIs
- Do not introduce editor plugin logic
- Do not overcomplicate with multi-agent frameworks
- Prefer simple local primitives
- Keep all decisions inspectable
- When uncertain, choose the simplest robust option

---

## Final Deliverable

A working local TypeScript orchestrator that can:

- plan a repo using Codex CLI
- execute tasks using Claude Code CLI
- review tasks using Codex CLI
- iterate automatically
- persist state and logs
- resume safely
- produce final reports

Now begin implementation.