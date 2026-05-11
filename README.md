# CEOrchestration

Local-first orchestrator for software engineering agents. You write tickets, a top-level **Director** agent dispatches sub-agents (Junior, Senior, Reviewer, Tester, …) turn-by-turn until the work is done. Single-user, runs on your machine, SQLite-backed, calls the `claude` CLI for LLM work.

It also runs **scheduled side-effects**: cron jobs that create tickets, send Telegram digests, post automated reviews on GitHub PRs.

## What it does (in one paragraph)

You drop a ticket like _"Add /version endpoint to api/"_. The Director reads project context + episodic memory of past runs + the skill library, sizes the ticket (trivial / standard / design-needed / cross-cutting), and dispatches sub-agents. Cheap Haiku-based **Junior** writes the bulk; expensive Opus-based **Senior** is the escalation. **Reviewer** + **Tester** can run in parallel against the same diff. **ci_gate** must pass before the run can be marked done (code-enforced). When the ticket needs context from elsewhere — _"work on JIRA DEV-123"_ — the Director fetches it from Jira/GitHub/SSH connectors. When work is done, terminal connectors fire: post a PR review, transition the Jira ticket, deploy via SSH.

## Prerequisites

- macOS / Linux
- Node.js ≥ 20
- `pnpm` ≥ 8 (`npm i -g pnpm`)
- `git` on PATH
- `claude` CLI on PATH and authenticated (`claude login`)

If `claude --version` fails:
```bash
npm i -g @anthropic-ai/claude-code
claude login
```

Override the binary path with `CEO_CLAUDE_BIN=/path/to/claude` if needed.

## Install + run

```bash
pnpm install
pnpm dev:server      # → http://localhost:4000
pnpm dev:web         # → http://localhost:5173
```

Open <http://localhost:5173>.

Data lives in `~/.ceo/`:
- `ceo.db` — SQLite (projects, tickets, runs, events, secrets, jobs)
- `projects/<id>/repos/<name>/` — cloned source repos
- `projects/<id>/runs/<run-id>/<repo>/` — per-run git worktrees

## First-time setup

### 1. Create a project

Project = one or more git repos that share a workflow + skills.

1. Top bar → "+ New project"
2. Name + description
3. Settings → add repos (`name` + `url` + default branch). Each gets cloned to `~/.ceo/projects/<id>/repos/<name>/`.

### 2. Configure agents (skills)

Each project gets a default skill set (Architect, Junior, Senior, Reviewer, Tester, Lint Gate, CTO, Memory Curator, DevOps, Tech Writer, …) imported from the global library. You can:

- Edit per-project: Project → **Workflow** → Skills panel. Edit prompts, model, allowed tools.
- Edit globally: Admin → Templates. Library-linked skills in projects are read-only and update live when you change the template.

For most workflows the defaults are enough. Don't touch unless you have a concrete reason.

### 3. Add connector secrets (optional but recommended)

If you want PR reviews, Jira sync, or SSH deploys, set credentials:

- **Admin → Connectors** for defaults shared by all projects (recommended)
- **Project → Settings → Connectors** for project-specific overrides

Each connector has a "Test connection" button. Result is cached so you see status + last-tested time at a glance. A red badge = expired token, fix it before runs start failing.

| Connector | What you need |
|---|---|
| GitHub | classic PAT with `repo` + `read:org` scopes; for organisations use SAML SSO authorize |
| Jira | base URL + email + API token (Atlassian → account settings → security) |
| SSH | path to private key + default target |
| Telegram | bot token from @BotFather + your chat ID (use `/chatid` command in the bot) |

### 4. Turn on the scheduler

Admin top-right has a scheduler toggle. Default is **paused** (safer for a fresh install). Click **Running** to let it auto-pick the highest-priority eligible ticket every 5 s. Persists across restarts.

`max_concurrent = 2` by default — two runs may execute at once, but only if they touch different repos (repo locking is automatic).

## Daily flow

### Adding tickets

Three ways:

- **One at a time:** Board → "+ New ticket". Title + body, auto-triage on. Triage agent assigns priority (P0–P3), repos_touched, brief notes, then drops to Backlog.
- **Bulk paste:** Board → "Bulk import". Paste markdown — either `## Title\nbody` blocks repeated, or a `- bullet list` of one-liners. See format details in the dialog.
- **Free-form spec → auto-decompose:** Open Bulk import, paste your `zadani.md` or brain dump, click **"↻ Rozložit spec na tickety"**. A CTO-like agent rewrites it into the bulk format with `Title / Acceptance / Hints`. Review, edit, import.

### Running tickets

If the scheduler is on, eligible tickets start automatically (priority order, deps satisfied, repo not locked, daily cost cap not hit).

Manual run: open a ticket → "▶ Run now". Bypasses scheduler queue but still respects locks + cost cap.

### Watching a run

Click any active ticket on the board → Run view opens. You see:

- **Director decisions** turn by turn: which sub-agent it dispatched, what notes it sent, the verdict that came back.
- **Cost** counter — per-run budget defaults $20, paused if exhausted (you can extend +50% from the UI).
- **Diff per repo** — what the sub-agents actually wrote.
- **Awaiting approval banner** — appears in two cases:
  1. Budget exhausted → click Approve to extend budget +50% and resume.
  2. Director hit a truly irreversible operation (drop table, prod deploy) → answer the question, click Approve. Director resumes with your answer in its history.

When the run finishes, you can rate it: **✓ Funguje** / **✗ Špatně** / **⚠ Rozbilo se v produkci**. Bad/broken ratings show up as anti-patterns in the next run's episodic memory.

### Reviewing the work

Succeeded runs auto-finalize the ticket to **done**. The Director already enforced `ci_gate` and ran Reviewer/Tester — by the time you see "done", three independent checks have passed.

To open a GitHub PR from a run: Run view → **"Open PR"**. Push happens with the run's branch (`ceo/<slug>-<run-id>`).

If you find a bug later, click "⚠ Rozbilo se v produkci" on that run. The Director won't make the same mistake on similar tickets in the future.

## Advanced features

### Subticket decomposition

For cross-cutting tickets (touches DB + auth + frontend in one go) the Director will request `decompose`. A CTO agent splits it into ~3–8 independently-deliverable subtickets with explicit dependencies (`depends_on`). Scheduler runs them in dependency order automatically.

### Connectors during a run

If a ticket references external state, the Director fetches it before coding:

- "Work on DEV-123" → `fetch_context jira { key: "DEV-123" }` pulls the issue body, status, assignee
- "Review the diff on PR 42" → `fetch_context github { kind: "pr", repo: "x/y", number: 42 }`
- "Fix the bug in /etc/nginx/nginx.conf" → `fetch_context ssh { path: "/etc/nginx/nginx.conf" }`

Fetched content is logged + appears in the Director's next turn as context for the sub-agent.

Connectors must be wired in the project's workflow (`Workflow` panel → Connectors). Just setting secrets is not enough — the connector must exist as a phase.

### Scheduled jobs

Admin → Jobs. Cron or watch-trigger jobs that:

- **Create tickets** on schedule ("weekly lint sweep")
- **Telegram digest** ("daily stats at 9 AM")
- **Review PRs** automatically (watches `is:pr is:open review-requested:@me`, posts inline review comments)
- **GitHub ops** (label, comment, dispatch_workflow on schedule)
- **Webhook** (Slack alert on new PR, etc.)
- **Custom Telegram message** with `{watch_*}` template vars

Jobs can fan out across multiple projects. State (seen PRs, baseline, dedup) is per-project.

### Telegram bot

Set `TELEGRAM_BOT_TOKEN` env var, restart server. Commands:
- `/help` — list commands
- `/list` — projects + ticket counts
- `/jobs` — scheduled job activity
- `/digest` — current stats snapshot
- `/quick` — fast ticket entry
- `/chatid` — print your chat ID (for `TELEGRAM_OUTPUT_CHAT_ID`)

Or just chat with it — a conversational assistant (Sonnet) parses your messages and creates tickets or jobs by emitting `CREATE_TICKET:` / `CREATE_JOB:` markers.

### Observability

Admin → Activity. Shows last 7/30/90 days:
- Run counts by status + failure rate
- Total cost + daily cost series
- Top failing phases (which gate bounces the most)
- Per-subagent stats (dispatched, ok rate, avg cost) — see which skill is worth its money
- User verdict counts — how much signal you've given the feedback loop

## How to think about this

- **You write tickets, not code.** The team writes code. You judge results (verdict buttons).
- **Director makes decisions, you don't.** If it asks you something, that's a bug — file it and we'll tighten the prompt. The only legit pause is budget exhaustion or genuinely irreversible operations.
- **Memory is per-project + per-run.** Episodic memory (recent runs + your verdicts) is the long-term learning. There's no global "the AI got smarter" — only "this project's memory has more patterns now."
- **Cost is real and visible.** Every run shows total cost. Daily cap per project. Budget per run. You can extend mid-run.

## Where to look when something goes wrong

| Symptom | Check |
|---|---|
| Ticket stuck in backlog | Scheduler is `paused` (Admin top-right) |
| Backlog has 5 tickets but only 1 runs | Sequential dependency chain (`depends_on`) or repo lock |
| Director asks weird permission questions | System prompt got too permissive — file an issue |
| Run failed with "Director crashed: ..." | claude CLI timeout / rate limit. Already auto-retried 3× with backoff — investigate if persistent |
| Connector test fails | Token expired, fix in Admin → Connectors or project Settings |
| Worktree disk usage high | Auto-cleaned: cancelled >12h, failed >7d, succeeded >30d. Manual: delete the run row, worktree follows |

For deep dives, see [CLAUDE.md](./CLAUDE.md) — architectural invariants, persistence schema, "how to add things safely" recipes.

## Layout

```
apps/server   Express + better-sqlite3 + scheduled-jobs runner + claude CLI wrapper
apps/web      Vite + React UI
packages/shared   Discriminated unions for all API shapes (single source of truth)
```
