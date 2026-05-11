# CEOrchestration — developer guide for Claude

This file is the working manual for Claude (and human developers) working on this
codebase. It's both a **feature inventory** and a **set of invariants** —
read it before making changes, especially the "Don't break this" sections.

## What this is

CEOrchestration is a **multi-agent code-orchestration tool**. A human types a
ticket; a top-level Claude agent (Director) reads project context + skill
library + episodic memory and dispatches sub-agents (Junior, Senior, Reviewer,
Tester, …) turn-by-turn until the work is done. Single-user, runs locally,
SQLite-backed, claude CLI for LLM calls.

It also runs **scheduled side-effects**: cron jobs that create tickets, push
digests to Telegram, post automated reviews on GitHub PRs, etc.

---

## Architecture at a glance

```
apps/server/src/      Express + better-sqlite3 + scheduled-jobs runner
  director.ts           Top-level Claude orchestrator (per-run engine)
  runs.ts               Run lifecycle: worktrees, phase loop, hooks
  scheduledJobs.ts      Cron + watch trigger runner; review_pr; fan-out
  agents.ts, oneShot.ts Claude CLI wrappers (stream-json + json modes)
  tasks/                Connector executors (github, jira, ssh, telegram, shell)
  routes/               Express routes per resource
  store.ts              Project / ticket / run readers; hand-rolled SQL
  projectSecrets.ts     Per-project secrets store (DB-backed)
  globalSecrets.ts      Admin-level secrets (parallel table)
  connectorTests.ts     Shared test-connection logic for both scopes

apps/web/src/          React + Vite SPA
  components/
    ProjectView, AdminView    Top-level
    WorkflowEditor            Skills + Gates + Connectors editor
    JobsAdmin                 Scheduled jobs CRUD + activity feed
    JobActivityFeed           Filterable job_runs log
    NotificationsBell         Top-right unread bell
    ConnectorSecretsPanel     Reusable secrets editor (project + global)

packages/shared/src/   Discriminated unions for Trigger / Action / etc.
                       The single source of truth for API shapes.
```

---

## Feature inventory

### Director-pattern orchestration (core)
- Director picks turn-by-turn which sub-agent to dispatch — no static phase graph
- Skills (named sub-agents): Architect, Junior, Senior, Reviewer, Tester, Closer, …
- Gates (deterministic checks): CI, lint. `mark_done` is **code-enforced** to
  require a successful `ci_gate` in the run history
- Connectors (side-effect integrations): GitHub, Jira, SSH, Telegram. Auto-fire
  at run terminal. Multi-action with per-action triggers (always / success /
  failure)
- Per-run **token budget** with pause-on-exhaustion → `awaiting_approval`. User
  approves to extend by ~50% (min +$5), state persisted across pause
- Director **state rebuild from event log** — server restart or budget-resume
  picks up where it left off, no double-charging
- Per-agent **dispatch cap** (4) prevents infinite loops
- Episodic memory: last N succeeded runs in markdown context

### Project / workflow management
- Multi-repo projects (one project = N repos sharing a workflow)
- WorkflowEditor: Skills (in capability swimlanes) + Gates + Connectors
- Workflow templates: built-in + user-saved, applyable to new projects
- Skill template library (admin) — imported skills are **read-only** in
  projects with **live overlay** (admin edits propagate everywhere)
- Per-project memory (rolling MEMORY.md, curated by an agent)
- Daily cost cap (USD) per project — scheduler skips, in-flight aborts at
  next phase boundary

### Connector secrets (3-tier resolution)
- **Project secrets** (per-project DB rows) — primary
- **Global secrets** (admin-level, paralelní table) — fallback
- **Env vars** (declared on `SECRET_SPECS`) — legacy fallback

Resolution order in `getProjectSecret`: project → global → env.
For global jobs (`project_id = null`): global → env.

UI is data-driven from `SECRET_SPECS` registry — adding a new secret means
appending one entry there and the UI auto-renders the form.

Test-connection works for github / jira / ssh; reused via `connectorTests.testConnector(group, get)`.

### Scheduled jobs
Trigger + Action are orthogonal:
- **Triggers**: `cron` (5-field or `@once:<ISO>`) | `watch` (poll source)
- **Actions**: `create_ticket` | `telegram_digest` | `scheduler_mode` | `review_pr`

Watch dedup uses **head SHA per PR** in `state.seen_prs` so:
- New PR → action fires
- Same PR + same SHA + different `updated_at` (label / comment changed) → skip
- Same PR + new SHA (commit) → action fires again
- First poll → baseline (no action), subsequent polls → diff fire

Fan-out scope: job runs **once per project** in `fan_out_project_ids`, each
with its own sub-state in `state.per_project[pid]`.

Single project + fan-out N=1 are equivalent at the UI level (just "Projekty"
with one checkbox); backend always normalizes to fan-out shape on save.

### Code review on GitHub
- Watches GitHub Search results (e.g. `is:pr is:open review-requested:@me`)
  across orgs the token has access to (needs `read:org` + SAML SSO authorized)
- Reviewer agent gets unified diff (cap 120 KB), returns structured JSON with
  inline comments only — **no summary, no verdict**
- Posts as proper GitHub PR Review (`POST /pulls/{n}/reviews`) with inline
  anchors at file:line, severity emoji prefix, `event: COMMENT` (never
  REQUEST_CHANGES — formal block confuses humans)
- Comments are **in Czech**, short (1-3 sentences), with concrete fix
  (often a code block)
- 422 fallback (model invented a line outside the diff) → degraded as a
  single issue comment, never dropped
- Ad-hoc endpoint `POST /api/jobs/review-pr-now { repo, pr_number, … }`
  bypasses watch dedup for one-off reviews
- Dry-run mode (`post_comment: false`) generates + persists to `details_json`
  but doesn't post

### Notifications & logs
- `job_runs` table — append-only log, indexed by (notable, fired_at).
  Pruned daily at 90 days
- NotificationsBell (fixed top-right) polls unread-count every 30s; dropdown
  shows 10 most recent notable; `lastSeenAt` in localStorage
- JobActivityFeed: filterable list (time / status / job / notable). Admin
  scope = all; project scope = filtered to project. Lazy-loads `details_json`
  (16 KB blob) only on row expand
- Detail viewer pretty-prints ReviewerOutput (comments grouped per file)
- Telegram notifications fire on action with `notify: true`, tagged with
  project key_prefix on fan-out runs

### Telegram bot
- Long-poll, opt-in via `TELEGRAM_BOT_TOKEN`
- Commands: `/help`, `/list`, `/jobs`, `/digest`, `/quick`, `/reset`, `/chatid`
- Conversational assistant (Sonnet) parses `CREATE_TICKET:` / `CREATE_JOB:`
  markers; state snapshot includes projects, runs, jobs
- Two-tier chat: `TELEGRAM_OUTPUT_CHAT_ID` for completion notifications,
  input chat stays clean

---

## Don't break this — architectural invariants

These are **load-bearing** assumptions. Touching them needs a careful think.

### 1. Single source of truth for shapes is `packages/shared/src/index.ts`
- All API request/response types go there
- Discriminated unions for `ScheduledJobTrigger`, `ScheduledJobAction`,
  `WorkflowPhase.kind`, etc. — `type` field is the discriminator
- When adding a variant, update validators in both directions (server-side
  `validateXShape` + client-side TypeScript)
- Don't redeclare local copies in apps/server or apps/web — import from shared

### 2. SQL queries use `?` parameter binding, never string interpolation
- Every WHERE clause that includes user input must use `?` and pass via
  `prepare(...).get(...args)` or `.all(...args)`
- We had a SQL injection bug on `/job-runs/unread-count` from inline
  `${query.project_id.replace(/'/g, "''")}` — don't do this again
- Exception: column names / sort orders / hardcoded constants in SQL are fine

### 3. Connector secret resolution chain is `project → global → env`
- `getProjectSecret(projectId, key)` does the full chain. Use it always
- Don't add a 4th level without redesigning `SECRET_SPECS`
- Plaintext **never leaves the server** over HTTP. List endpoints mask tokens
  via `mask()` in `projectSecrets.ts`. New secret types must declare
  `secret: true` if they should be masked
- Adding a new secret = one entry in `SECRET_SPECS` + (optional) env fallback

### 4. Job state is partitioned per scope
- Single-scope jobs use the top-level `JobState` (seen_prs, baseline_recorded, …)
- Fan-out jobs partition into `state.per_project[pid]` with the same shape
- `recent_results` lives at the OUTER level (single ring buffer for the job
  with project_id tag per entry), not duplicated per partition
- Scope change in `updateJob` resets `state_json = NULL` to avoid mixing
  dedup spaces

### 5. Concurrent job execution is locked
- `firingJobs: Set<string>` is the in-memory lock both `fireJobNow` and
  `tick()` honor
- `tick()` ALSO uses an atomic DB claim (`UPDATE … SET next_run_at = NULL
  WHERE next_run_at = ?`) for cross-tick safety
- Don't add a third execution path that bypasses both

### 6. `JobRun.summary` "ok" detection is `isErrorResult()` regex
- Action results don't always start with `error:` (review_pr returns
  shape-prefixed messages). The `isErrorResult` regex sniffs `failed`,
  `HTTP 4xx/5xx`, `crashed`, `error:`
- If you add new error message shapes, extend the regex
- Better long-term: make every action return `{ ok: boolean }` explicitly.
  Until then, regex is the bridge

### 7. Director and review_pr both use `extractJsonWithFallback`
- The Claude CLI emits stream-json with multiple events including
  `rate_limit_event` warning lines. **Don't `JSON.parse(stdout)` directly**
  or you'll parse a warning as the response
- `extractJsonWithFallback` walks the transcript, picks the final assistant
  text, and pulls the JSON blob out

### 8. Hot-reload during long-running operations is dangerous
- The dev server uses `tsx watch`. Editing a TS file mid-call kills the
  process and breaks open connections (curl returns HTTP 000 / exit 52)
- Long-running ops (Director runs, review_pr posts) take minutes — don't
  edit code while one is in flight unless you're ready to retry
- Production deployments use `tsx` (no watch); same care needed for SIGTERM

### 9. UI state for wizard-driven configs is locked, not just disabled
- When a wizard preset has determined a field (action type, trigger type,
  source), the UI shows a **read-only label**, not a disabled `<select>`
- Disabled selects look like "you could change this if not for some reason"
  — wrong signal. Read-only labels say "this is what it is"
- "← Zpět na výběr" is the consistent escape hatch back to the picker

### 10. `text-transform: uppercase` cascades from `.form-row label`
- The shared CSS uppercases labels in form rows. This **cascades into
  nested elements** if you put descriptive prose inside `<label>` children
- For multi-paragraph or descriptive content, wrap in a plain `<div>` with
  `textTransform: "none"` and use a `<button>` instead of `<label>` for
  click targets
- This bit us in the ScopePicker — don't repeat

---

## Module dependency rules

```
shared/        ←  apps/server/, apps/web/   (one-way)
agents.ts      ←  oneShot.ts, runs.ts
claude.ts      ←  agents.ts, oneShot.ts
projectSecrets ↔  globalSecrets             (circular OK at runtime; lazy bindings)
connectorTests ←  routes/projects, routes/admin
```

Server modules generally form a DAG. The only intentional circular import is
`projectSecrets ↔ globalSecrets` because the resolution chain crosses both —
this works because the call site is at runtime, not module init.

Don't import from `apps/web` into `apps/server` or vice versa. Use the
shared package.

---

## Persistence (SQLite at `~/.ceo/ceo.db`)

Tables (with relevant invariants):

- `projects` — `id, name, key_prefix, workflow_json, daily_cost_cap_usd, …`
- `repos` — projects' git roots (worktree-cloned per run)
- `tickets` — backlog/inbox/running/done; `ticket_key` is human-readable
- `runs` — Director runs; `status` ∈ pending/running/awaiting_approval/
  succeeded/failed/cancelled; `director_budget_override_usd` for resume
- `run_events` — append-only stream of run lifecycle events; Director
  rebuilds history from `director_decision` + `director_subagent_done`
- `agents` — project-level skill instances. `template_key` non-null = library-linked
- `scheduled_jobs` — config; `payload_json` holds `{trigger, action, fan_out_project_ids}`;
  `state_json` holds `JobState`
- `job_runs` — append-only log; `details_json` for review_pr structured payload;
  pruned at 90 days
- `project_secrets` / `global_secrets` — plaintext secret values, masked on read
- `kv` — small key-value (Telegram offset, assistant chat history)

**Migrations** are `ensureColumn` / `CREATE TABLE IF NOT EXISTS` patterns in
`db.ts` — additive only, never drop columns. New columns must have defaults
or be nullable so old rows still load.

---

## How to add things safely

### Add a new task type (connector / gate)
1. Implement `TaskExecutor` in `apps/server/src/tasks/<name>.ts` (validate +
   run methods)
2. Register in `tasks/index.ts` (and `CONNECTOR_TASK_TYPES` if connector)
3. Add UI form in `WorkflowEditor.tsx` (`TASK_TYPES` registry + Sub-Form
   component)
4. For connector: add UI sub-form, default config with `actions: []` shape

### Add a new scheduled-job action
1. Add interface to `packages/shared/src/index.ts` `ScheduledJobAction` union
   (`type` is the discriminator)
2. Add validation in `scheduledJobs.ts` `validateAction`
3. Add dispatcher branch in `runAction()`
4. Add `defaultActionFor()` entry in `JobsAdmin.tsx`
5. Add sub-form in `JobsAdmin.tsx` `ActionEditor`
6. Add to a preset's `allowed_actions` if it should be wizard-pickable
7. Update `validateActionShape` for read-side parsing

### Add a new connector secret
1. Append entry to `SECRET_SPECS` in `projectSecrets.ts` (key, label,
   secret bool, env fallback, hint)
2. UI auto-renders. No frontend changes needed
3. If the secret needs a connection-test branch, extend `connectorTests.ts`

### Add a Director action
1. Add interface to `DirectorAction` union in `director.ts`
2. Branch in main loop
3. Document in the Director's system prompt strategy rules
4. Add `enforceGuardrails` rule if needed

### Add an admin-level feature
1. Endpoint in `routes/admin.ts`
2. API helper in `apps/web/src/api.ts`
3. UI section: new `AdminSection` in `router.ts` + tab in `AdminView.tsx`

---

## Common gotchas

- **`tsx watch` reloads on file change** — don't edit TypeScript while a
  long curl is in flight; you'll get HTTP 000
- **claude CLI verbose mode is the default** — stdout has many JSON events
  including rate-limit warnings; use `extractJsonWithFallback`, never `JSON.parse(stdout)`
- **GitHub Search API has secondary rate limits** — fan-out + watch with
  large queries can trip them. SHA fetches are batched at concurrency 5
- **GitHub PR reviews can't truly be deleted** — submitted reviews can only
  be dismissed + body-edited. Be careful posting on real PRs (we use
  `event: COMMENT`, never `REQUEST_CHANGES`, to minimize damage)
- **Watch baseline is critical** — first poll records but doesn't fire,
  otherwise enabling a watch on a busy query creates a flood. Don't reset
  state without setting `baseline_recorded: true`
- **Library-linked skills are immutable in the project** — UI must not
  expose paths to break the link (no "switch agent" picker, no edit
  controls). The link is the contract
- **Worktrees are per-repo per-run** — concurrent runs share repo, the
  scheduler enforces repo-locks across active runs
- **`@once:<ISO>` triggers are one-shot** — auto-disabled after fire (sets
  enabled=0, next_run_at=null)

---

## Testing the system manually

```bash
# Test GitHub token validity
curl -s -X POST http://localhost:4000/api/admin/secrets/github/test

# Force a one-off review on a PR (bypasses watch)
curl -X POST http://localhost:4000/api/jobs/review-pr-now \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/name", "pr_number": 42, "post_comment": false}'

# Run a job now (atomic claim respected)
curl -X POST http://localhost:4000/api/jobs/<id>/run-now

# Inspect job state
sqlite3 ~/.ceo/ceo.db "SELECT state_json FROM scheduled_jobs WHERE id='<id>';"

# See recent activity
sqlite3 ~/.ceo/ceo.db "SELECT fired_at, ok, summary FROM job_runs ORDER BY id DESC LIMIT 10;"
```

---

## Conventions

- **Comments**: explain *why*, not *what*. Code names already say what
- **No emojis in code unless the user asked for them** (UI labels, log lines,
  Telegram messages — those are user-facing)
- **Czech for user-visible UI** (most labels), English for code / logs / API
  responses
- **Errors throw with messages humans can act on**: include file paths,
  endpoints, what to check
- **`(e: unknown)` not `(e: any)`** in catches; narrow with `instanceof Error`
- **Brand display name is "CEOrchestration"**; technical prefix in code /
  packages stays `ceo` / `@ceo/*` (not worth migrating)
