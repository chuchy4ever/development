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

export function nowIso(): string {
  return new Date().toISOString();
}
