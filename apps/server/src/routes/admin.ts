import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { db } from "../db.js";
import { DATA_DIR } from "../config.js";
import type { WorkflowPreset } from "@ceo/shared";

export const adminRouter = Router();

interface OverviewStats {
  projects_count: number;
  agents_count: number;
  tickets_by_status: Record<string, number>;
  runs_by_status: Record<string, number>;
  runs_total: number;
  total_cost_usd: number;
  cost_by_project: Array<{
    project_id: string;
    project_name: string;
    total_cost_usd: number;
    today_cost_usd: number;
    daily_cost_cap_usd: number | null;
    runs: number;
  }>;
  cost_last_7_days: Array<{ date: string; cost: number; runs: number }>;
}

adminRouter.get("/overview", (_req, res) => {
  const projects_count = (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  const agents_count = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
  const runs_total = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  const total_cost_usd = (db.prepare("SELECT COALESCE(SUM(total_cost_usd), 0) AS s FROM runs").get() as { s: number }).s;

  const ticketRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status")
    .all() as { status: string; n: number }[];
  const tickets_by_status: Record<string, number> = {};
  for (const r of ticketRows) tickets_by_status[r.status] = r.n;

  const runRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM runs GROUP BY status")
    .all() as { status: string; n: number }[];
  const runs_by_status: Record<string, number> = {};
  for (const r of runRows) runs_by_status[r.status] = r.n;

  const costRows = db
    .prepare(`
      SELECT p.id AS project_id, p.name AS project_name,
             p.daily_cost_cap_usd AS daily_cost_cap_usd,
             COALESCE(SUM(r.total_cost_usd), 0) AS total_cost_usd,
             COALESCE(SUM(CASE WHEN date(r.created_at) = date('now')
                               THEN r.total_cost_usd ELSE 0 END), 0) AS today_cost_usd,
             COUNT(r.id) AS runs
        FROM projects p
        LEFT JOIN runs r ON r.project_id = p.id
       GROUP BY p.id
       ORDER BY total_cost_usd DESC
    `)
    .all() as Array<{
      project_id: string;
      project_name: string;
      daily_cost_cap_usd: number | null;
      total_cost_usd: number;
      today_cost_usd: number;
      runs: number;
    }>;

  const dailyRows = db
    .prepare(`
      SELECT substr(created_at, 1, 10) AS date,
             COALESCE(SUM(total_cost_usd), 0) AS cost,
             COUNT(*) AS runs
        FROM runs
       WHERE created_at >= date('now', '-7 days')
       GROUP BY date
       ORDER BY date ASC
    `)
    .all() as Array<{ date: string; cost: number; runs: number }>;

  const stats: OverviewStats = {
    projects_count,
    agents_count,
    tickets_by_status,
    runs_by_status,
    runs_total,
    total_cost_usd,
    cost_by_project: costRows,
    cost_last_7_days: dailyRows,
  };
  res.json(stats);
});

interface RecentRun {
  run_id: string;
  status: string;
  agent_role: string;
  current_agent_name: string | null;
  total_cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  project_id: string;
  project_name: string;
  ticket_id: string;
  ticket_key: string | null;
  ticket_title: string;
}

interface MetricsResponse {
  window_days: number;
  run_counts: Record<string, number>;
  failure_rate_pct: number;
  total_cost_usd: number;
  daily_series: Array<{ date: string; succeeded: number; failed: number; cost: number }>;
  top_failing_phases: Array<{ phase_id: string; fails: number }>;
  longest_phases: Array<{ phase_id: string; avg_duration_ms: number; samples: number }>;
}

adminRouter.get("/metrics", (req, res) => {
  // Sanitize: parseInt rejects scientific notation / Infinity, isFinite catches NaN.
  const raw = parseInt(String(req.query.days ?? "7"), 10);
  const safe = Number.isFinite(raw) && raw > 0 ? raw : 7;
  const days = Math.min(Math.max(safe, 1), 90);

  // Run counts by status in window.
  const runRows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
         FROM runs
        WHERE created_at >= date('now', ?)
        GROUP BY status`,
    )
    .all(`-${days} days`) as { status: string; n: number }[];
  const run_counts: Record<string, number> = {};
  for (const r of runRows) run_counts[r.status] = r.n;

  const succeeded = run_counts.succeeded ?? 0;
  const failed = run_counts.failed ?? 0;
  const failure_rate_pct =
    succeeded + failed > 0 ? (failed / (succeeded + failed)) * 100 : 0;

  const total_cost_usd = (
    db
      .prepare(
        `SELECT COALESCE(SUM(total_cost_usd), 0) AS s
           FROM runs
          WHERE created_at >= date('now', ?)`,
      )
      .get(`-${days} days`) as { s: number }
  ).s;

  // Daily series: succeeded/failed counts + cost.
  const dailyRows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS date,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(total_cost_usd), 0) AS cost
         FROM runs
        WHERE created_at >= date('now', ?)
        GROUP BY date
        ORDER BY date ASC`,
    )
    .all(`-${days} days`) as Array<{ date: string; succeeded: number; failed: number; cost: number }>;

  // Top failing phases: phase_end events with verdict ok=false, grouped by phase_id.
  // Payload is JSON; SQLite json_extract is fine.
  const failingRows = db
    .prepare(
      `SELECT json_extract(payload, '$.phase_id') AS phase_id, COUNT(*) AS fails
         FROM run_events
        WHERE type = 'phase_end'
          AND json_extract(payload, '$.verdict.ok') = 0
          AND ts >= datetime('now', ?)
        GROUP BY phase_id
        ORDER BY fails DESC
        LIMIT 10`,
    )
    .all(`-${days} days`) as Array<{ phase_id: string | null; fails: number }>;
  const top_failing_phases = failingRows
    .filter((r) => r.phase_id !== null)
    .map((r) => ({ phase_id: r.phase_id as string, fails: r.fails }));

  // Longest phases: average duration_ms from phase_end (only if present in payload).
  const durationRows = db
    .prepare(
      `SELECT json_extract(payload, '$.phase_id') AS phase_id,
              AVG(json_extract(payload, '$.verdict.duration_ms')) AS avg_dur,
              COUNT(*) AS samples
         FROM run_events
        WHERE type = 'phase_end'
          AND json_extract(payload, '$.verdict.duration_ms') IS NOT NULL
          AND ts >= datetime('now', ?)
        GROUP BY phase_id
        ORDER BY avg_dur DESC
        LIMIT 10`,
    )
    .all(`-${days} days`) as Array<{ phase_id: string | null; avg_dur: number | null; samples: number }>;
  const longest_phases = durationRows
    .filter((r) => r.phase_id !== null && r.avg_dur !== null)
    .map((r) => ({
      phase_id: r.phase_id as string,
      avg_duration_ms: Math.round(r.avg_dur as number),
      samples: r.samples,
    }));

  const out: MetricsResponse = {
    window_days: days,
    run_counts,
    failure_rate_pct,
    total_cost_usd,
    daily_series: dailyRows,
    top_failing_phases,
    longest_phases,
  };
  res.json(out);
});

adminRouter.get("/recent-runs", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const rows = db
    .prepare(`
      SELECT r.id AS run_id, r.status, r.agent_role, r.current_agent_name,
             r.total_cost_usd, r.started_at, r.finished_at, r.created_at,
             r.project_id, p.name AS project_name,
             r.ticket_id, t.ticket_key, t.title AS ticket_title
        FROM runs r
        LEFT JOIN projects p ON p.id = r.project_id
        LEFT JOIN tickets  t ON t.id = r.ticket_id
       ORDER BY r.created_at DESC
       LIMIT ?
    `)
    .all(limit) as RecentRun[];
  res.json(rows);
});

// Browse the local filesystem (single-user app — no sandboxing). Returns
// directory contents + git-repo flag so the UI can render a folder picker.
adminRouter.get("/browse", (req, res) => {
  const rawPath = (req.query.path as string | undefined)?.trim();
  let target: string;
  if (!rawPath) {
    target = os.homedir();
  } else if (rawPath.startsWith("~/")) {
    target = path.join(os.homedir(), rawPath.slice(2));
  } else {
    target = path.resolve(rawPath);
  }

  if (!fs.existsSync(target)) {
    return res.status(400).json({ error: `path does not exist: ${target}` });
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: `not a directory: ${target}` });
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (e: any) {
    return res.status(403).json({ error: `cannot read directory: ${e.message ?? e}` });
  }

  const entries = dirents
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      is_dir: true,
      is_git: fs.existsSync(path.join(target, d.name, ".git")),
      is_hidden: d.name.startsWith("."),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  res.json({
    path: target,
    parent: parent !== target ? parent : null,
    is_git: fs.existsSync(path.join(target, ".git")),
    entries,
  });
});

// Create a new directory under a parent path (used by the folder picker).
adminRouter.post("/mkdir", (req, res) => {
  const parent = (req.body?.parent as string | undefined)?.trim();
  const name = (req.body?.name as string | undefined)?.trim();
  if (!parent || !name) {
    return res.status(400).json({ error: "parent and name are required" });
  }
  if (!/^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(name)) {
    return res.status(400).json({ error: "invalid folder name" });
  }
  const parentResolved = parent.startsWith("~/")
    ? path.join(os.homedir(), parent.slice(2))
    : path.resolve(parent);
  if (!fs.existsSync(parentResolved) || !fs.statSync(parentResolved).isDirectory()) {
    return res.status(400).json({ error: `parent does not exist: ${parentResolved}` });
  }
  const target = path.join(parentResolved, name);
  if (fs.existsSync(target)) {
    return res.status(400).json({ error: "folder already exists" });
  }
  try {
    fs.mkdirSync(target, { recursive: false });
  } catch (e: any) {
    return res.status(500).json({ error: `mkdir failed: ${e.message ?? e}` });
  }
  res.status(201).json({ path: target });
});

// Import a workflow preset from a posted JSON body.
adminRouter.post("/templates/import", (req, res) => {
  const tpl = req.body as WorkflowPreset;
  if (!tpl?.key || !tpl?.name || !Array.isArray(tpl.agents) || !Array.isArray(tpl.phases)) {
    return res.status(400).json({ error: "invalid template payload (key, name, agents[], phases[] required)" });
  }
  if (!tpl.key.match(/^[a-z0-9_-]+$/i)) {
    return res.status(400).json({ error: "key must be alphanumeric (with - or _)" });
  }
  const dir = path.join(DATA_DIR, "templates");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${tpl.key}.json`);
  // Always treat imported as user-source.
  const out = { ...tpl, source: "user" as const };
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2), "utf8");
  res.status(201).json(out);
});
