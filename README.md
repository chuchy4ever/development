# ceo

Visual orchestration for software engineering agents, running locally on top of the `claude` CLI.

**Status: Phase 1 (foundation).** What works today:
- Create projects, attach multiple git repos (auto-cloned to `~/.ceo/projects/<id>/repos/<name>`).
- Write tickets in an Inbox (free text).
- A **Triage agent** classifies each ticket via `claude` CLI: priority, workflow template, repos touched, short notes — and moves it to Backlog.
- Kanban board view of tickets across Inbox → Backlog → Running → Review → Done → Blocked.

Not yet: workflow execution (Coder / Reviewer / Tester runs), worktree manager, visual workflow editor, scheduler. Those are Phases 2–4.

## Prerequisites

- Node.js ≥ 20
- `git` on PATH
- `claude` CLI on PATH and authenticated (`claude login`)

If `claude --version` fails, your install is broken (typical: `npm i --omit=optional` skipped the native binary). Reinstall:

```bash
npm i -g @anthropic-ai/claude-code
claude --version
```

You can override the binary path with `CEO_CLAUDE_BIN=/path/to/claude`.

## Run

```bash
npm install
npm run dev:server      # → http://localhost:4000
npm run dev:web         # → http://localhost:5173
```

Open http://localhost:5173.

## Layout

```
apps/server   Express + SQLite + claude CLI wrapper
apps/web      Vite + React UI
packages/shared   Shared TypeScript types
```

Data lives in `~/.ceo/`:

```
~/.ceo/
  ceo.db                   SQLite (projects, repos, tickets)
  projects/<project-id>/
    repos/<repo-name>/     Cloned git repos
```

## Smoke test

1. Create project "ERP integrace".
2. Settings → add a repo (use any small public repo for now, e.g. `https://github.com/octocat/Hello-World.git`).
3. Settings → fill in Spec ("BFF + S2S talking to ERP...").
4. Board → write ticket title + body, submit with auto-triage on.
5. Triage runs `claude -p ...` in the background; ticket should land in Backlog with a priority badge and notes.

If triage fails: open the ticket modal and read the error. The most common cause is `claude` not on PATH.
