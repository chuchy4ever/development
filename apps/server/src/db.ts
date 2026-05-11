import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./config.js";

ensureDirs();

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec_md TEXT NOT NULL DEFAULT '',
  tech_stack_md TEXT NOT NULL DEFAULT '',
  workflow_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inbox',
  priority TEXT,
  workflow_template TEXT,
  repos_touched TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  parent_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  triage_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project_id, status);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  agent_role TEXT NOT NULL DEFAULT 'coder',
  worktrees TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(project_id, status);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Development',
  system_prompt TEXT NOT NULL,
  model TEXT,
  allowed_tools_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  schedule TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_project ON scheduled_jobs(project_id);

-- Per-project secrets / config for connectors (github/jira/ssh tokens, etc.).
-- Plaintext on disk; user owns the machine. Never returned in plaintext over
-- HTTP — the API masks tokens to last-4 on read.
CREATE TABLE IF NOT EXISTS project_secrets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
`);

// Lightweight migrations: ALTER existing tables when columns are missing.
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("projects", "workflow_json", "workflow_json TEXT NOT NULL DEFAULT ''");
ensureColumn("agents", "category", "category TEXT NOT NULL DEFAULT 'Development'");
ensureColumn("runs", "total_cost_usd", "total_cost_usd REAL");
ensureColumn("projects", "key_prefix", "key_prefix TEXT NOT NULL DEFAULT ''");
ensureColumn("projects", "next_ticket_seq", "next_ticket_seq INTEGER NOT NULL DEFAULT 1");
ensureColumn("tickets", "ticket_key", "ticket_key TEXT");
ensureColumn("runs", "current_agent_name", "current_agent_name TEXT");
ensureColumn("runs", "current_phase_id", "current_phase_id TEXT");
ensureColumn("runs", "attempts_by_phase_json", "attempts_by_phase_json TEXT");
ensureColumn("runs", "reviewer_feedback", "reviewer_feedback TEXT");
ensureColumn("projects", "daily_cost_cap_usd", "daily_cost_cap_usd REAL");
ensureColumn("agents", "template_key", "template_key TEXT");
ensureColumn("runs", "director_budget_override_usd", "director_budget_override_usd REAL");
// Same pattern as budget override: when a paused run is approved with
// reason="max_iterations", bump the iteration cap (default +10) so the
// resumed Director gets headroom to finish. Without this, max_iter pauses
// would just immediately re-hit the same limit on resume.
ensureColumn("runs", "director_max_iter_override", "director_max_iter_override INTEGER");
// Why is this run paused? Drives resume behavior in decideDirectorPause:
//   'budget_exhausted' → approve bumps budget by ~50%
//   'human_review'     → approve resumes without changes (Director asked for
//                        human input mid-run; budget untouched)
//   NULL              → not paused, or paused via legacy 'approval' phase
ensureColumn("runs", "pause_reason", "pause_reason TEXT");
// User-facing run verdict — single-user feedback loop. Set after the run
// completes to mark it as good (works), bad (doesn't), or broken_in_prod
// (regressions found later). Memory Curator surfaces "bad" / "broken_in_prod"
// runs as anti-patterns in episodic memory.
ensureColumn("runs", "user_verdict", "user_verdict TEXT");
ensureColumn("runs", "user_verdict_at", "user_verdict_at TEXT");
ensureColumn("runs", "user_verdict_note", "user_verdict_note TEXT");
// Watch-trigger state: JSON blob holding seen IDs + bookkeeping. Cron-only
// jobs leave this null. We store on the row (not a side table) because state
// is small (typically <100 string IDs) and always read alongside the job.
ensureColumn("scheduled_jobs", "state_json", "state_json TEXT");
// Server-wide secrets (admin level) — parallel to project_secrets, used by
// global jobs that don't have a project context. Resolution order is
// project_secrets → global_secrets → env-var fallback.
db.exec(`
CREATE TABLE IF NOT EXISTS global_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// Persistent log of scheduled-job action invocations + trigger errors. One
// row per action fire (so fan-out jobs produce N rows per tick, one per
// project). Used by the NotificationsBell + JobActivityFeed UI. Job_name +
// action_type are denormalized so log entries survive job rename/delete.
db.exec(`
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  project_id TEXT,
  fired_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  notable INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  url TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_fired ON job_runs(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_project_fired ON job_runs(project_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_fired ON job_runs(job_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_notable_fired ON job_runs(notable, fired_at DESC);
`);
// Add structured review payload for review_pr runs — lets the UI show the
// full ReviewerOutput (summary + inline comments + verdict) without having
// to click out to GitHub. Capped server-side to ~16 KB.
ensureColumn("job_runs", "details_json", "details_json TEXT");

// Append-only ledger of every claude CLI invocation cost in USD. Captures
// spend that doesn't naturally land in `runs.total_cost_usd`:
//   - Triage, extract-from-spec (bulk-import time)
//   - Memory Curator, CTO decompose (within a director run; also bump runs.total_cost_usd)
//   - Telegram Assistant (conversational; no run / project context sometimes)
//   - review_pr scheduled action
// project_id null = global / unattributed. run_id null = not inside a director run.
// `todaysCostForProject` UNIONs runs.total_cost_usd + cost_log (WHERE run_id IS NULL)
// to compute daily cap without double-counting.
db.exec(`
CREATE TABLE IF NOT EXISTS cost_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_log_project_date ON cost_log(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cost_log_run ON cost_log(run_id);
`);

// Per-scope, per-connector last test result. Lets the UI surface "github
// token: 401 Bad credentials, last tested 2 days ago" without re-hitting the
// API on every page render. scope = 'global' for admin secrets, otherwise
// project_id. group = 'github' | 'jira' | 'ssh'.
db.exec(`
CREATE TABLE IF NOT EXISTS connector_health (
  scope TEXT NOT NULL,
  group_name TEXT NOT NULL,
  last_tested_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (scope, group_name)
);
`);

export function nowIso(): string {
  return new Date().toISOString();
}
