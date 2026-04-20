# Local Code Agent

Terminal-first TypeScript orchestrator for planning work with Codex CLI, implementing tasks with Claude Code CLI, and persisting state under `.ai-orchestrator/`.

## Quick Start

### 1. Install and build

```bash
npm install
npm run build
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

### 3. Add a spec

Create `.ai-orchestrator/spec.md` inside the target repo. This is the initial project prompt that Codex uses to plan the work.

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

You can keep this file short. It should be a grounded product/task spec, not a giant architecture document.

### 4. Generate a task plan

```bash
npm run dev -- plan --repo /path/to/project --spec /path/to/project/.ai-orchestrator/spec.md
```

What `plan` does:
- reads `.ai-orchestrator/spec.md`
- inspects the repo shape, recent commits, root `README.md`, and `package.json`
- sends that context to Codex
- asks Codex to break the work into small ordered tasks
- saves the result into `.ai-orchestrator/tasks.json`

This writes:
- `.ai-orchestrator/tasks.json`
- `.ai-orchestrator/config.json`
- planning prompts and raw outputs under `.ai-orchestrator/prompts/` and `.ai-orchestrator/artifacts/`

### 5. Execute work

Run the full dependency-aware flow:

```bash
npm run dev -- run --repo /path/to/project
```

This is the automatic mode. You do **not** need to manually run each task.

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

Run one task only:

```bash
npm run dev -- execute --repo /path/to/project --task TASK-001
```

The orchestrator uses a separate git worktree per task, but it does **not** create a task branch. Claude works in a detached worktree and regular commits are still allowed there.

### 6. Audit and report

```bash
npm run dev -- audit --repo /path/to/project
npm run dev -- report --repo /path/to/project --audit
```

### 7. Optional viewer

```bash
npm run dev -- viewer --repo /path/to/project --port 7842
```

Then open `http://127.0.0.1:7842`.

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

## Useful Commands

```bash
npm run dev -- run-task --repo /path/to/project --task TASK-001
npm run dev -- review --repo /path/to/project --task TASK-001
npm run dev -- execute --repo /path/to/project --task TASK-001
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

Keep the workflow grounded:
- start with a narrow spec
- run one project at a time
- inspect `tasks.json`, review artifacts, and reports instead of adding more abstraction
- prefer fixing a bad task or prompt over adding more orchestration logic
