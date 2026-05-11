import { Router } from "express";
import {
  computeNextRun,
  createJob,
  deleteJob,
  fireJobNow,
  getJob,
  listJobs,
  reviewPrAdHoc,
  updateJob,
} from "../scheduledJobs.js";
import { db } from "../db.js";
import type { CreateScheduledJobInput, UpdateScheduledJobInput } from "@ceo/shared";

export const jobsRouter = Router();

/** Persistent execution log for jobs. Independent from /api/jobs/:id (which
 *  is config) — this is what HAPPENED. Used by NotificationsBell + activity
 *  feed UI. */
export const jobRunsRouter = Router();

interface JobRunRow {
  id: number;
  job_id: string;
  job_name: string;
  action_type: string;
  project_id: string | null;
  fired_at: string;
  ok: number;
  notable: number;
  summary: string;
  url: string | null;
  details_json: string | null;
}

function rowToJobRun(r: JobRunRow) {
  let details: unknown;
  if (r.details_json) {
    try { details = JSON.parse(r.details_json); } catch { /* ignore corrupt */ }
  }
  return {
    id: r.id,
    job_id: r.job_id,
    job_name: r.job_name,
    action_type: r.action_type,
    project_id: r.project_id,
    fired_at: r.fired_at,
    ok: !!r.ok,
    notable: !!r.notable,
    summary: r.summary,
    url: r.url,
    details,
  };
}

jobRunsRouter.get("/", (req, res) => {
  // Filters: project_id (string | "null" | undefined), job_id, since (ISO),
  // ok ("true"/"false"), notable ("true"), limit (default 100, max 500).
  const where: string[] = [];
  const args: unknown[] = [];
  if (req.query.project_id === "null") where.push("project_id IS NULL");
  else if (typeof req.query.project_id === "string") {
    where.push("project_id = ?"); args.push(req.query.project_id);
  }
  if (typeof req.query.job_id === "string") { where.push("job_id = ?"); args.push(req.query.job_id); }
  if (typeof req.query.since === "string") { where.push("fired_at >= ?"); args.push(req.query.since); }
  if (req.query.ok === "true") where.push("ok = 1");
  else if (req.query.ok === "false") where.push("ok = 0");
  if (req.query.notable === "true") where.push("notable = 1");
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  // Skip details_json by default — can be 16 KB per row, would dominate the
  // payload on a 200-row poll. The presence flag lets the UI show a "detail"
  // button without loading the body. Caller fetches GET /:id for the full row.
  const sql = `SELECT id, job_id, job_name, action_type, project_id, fired_at,
                      ok, notable, summary, url,
                      (CASE WHEN details_json IS NULL THEN 0 ELSE 1 END) AS has_details
                 FROM job_runs ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY fired_at DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...args) as (Omit<JobRunRow, "details_json"> & { has_details: number })[];
  res.json(rows.map((r) => ({
    id: r.id,
    job_id: r.job_id,
    job_name: r.job_name,
    action_type: r.action_type,
    project_id: r.project_id,
    fired_at: r.fired_at,
    ok: !!r.ok,
    notable: !!r.notable,
    summary: r.summary,
    url: r.url,
    has_details: !!r.has_details,
  })));
});

/** Single-row endpoint with full details_json — called when the UI expands
 *  a row in the activity feed (lazy load). */
jobRunsRouter.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be integer" });
  const row = db.prepare("SELECT * FROM job_runs WHERE id = ?").get(id) as JobRunRow | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(rowToJobRun(row));
});

/** Lightweight unread-count endpoint for the bell. Polls cheap. */
jobRunsRouter.get("/unread-count", (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : "1970-01-01";
  const args: unknown[] = [since];
  let extra = "";
  if (req.query.project_id === "null") {
    extra = "AND project_id IS NULL";
  } else if (typeof req.query.project_id === "string") {
    extra = "AND project_id = ?";
    args.push(req.query.project_id);
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM job_runs WHERE notable = 1 AND fired_at > ? ${extra}`,
  ).get(...args) as { n: number };
  res.json({ count: row.n });
});

jobsRouter.get("/", (req, res) => {
  const projectId = req.query.project_id;
  const filter: { project_id?: string | null } = {};
  if (projectId === "null") filter.project_id = null;
  else if (typeof projectId === "string") filter.project_id = projectId;
  res.json(listJobs(filter));
});

jobsRouter.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

jobsRouter.post("/", (req, res) => {
  try {
    const input = req.body as CreateScheduledJobInput;
    const job = createJob(input);
    res.status(201).json(job);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

jobsRouter.patch("/:id", (req, res) => {
  try {
    const job = updateJob(req.params.id, req.body as UpdateScheduledJobInput);
    res.json(job);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

jobsRouter.delete("/:id", (req, res) => {
  const ok = deleteJob(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

jobsRouter.post("/:id/run-now", async (req, res) => {
  const r = await fireJobNow(req.params.id);
  if (!r.ok && r.result === "not found") return res.status(404).json({ error: "not found" });
  res.json(r);
});

/** Run a one-off review_pr on a specific PR — bypasses the watch trigger.
 *  Body: { repo, pr_number, project_id?, post_comment?, focus_mode?, agent_template_key?, agent_name? }. */
jobsRouter.post("/review-pr-now", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const repo = typeof body.repo === "string" ? body.repo : "";
  const prNumber = Number(body.pr_number);
  if (!repo || !prNumber) {
    return res.status(400).json({ error: "body needs { repo: 'owner/name', pr_number: number }" });
  }
  try {
    const r = await reviewPrAdHoc({
      repo,
      pr_number: prNumber,
      project_id: typeof body.project_id === "string" ? body.project_id : null,
      agent_template_key: typeof body.agent_template_key === "string" ? body.agent_template_key : undefined,
      agent_name: typeof body.agent_name === "string" ? body.agent_name : undefined,
      focus_mode: body.focus_mode === "critical_only" ? "critical_only" : "comprehensive",
      post_comment: body.post_comment !== false,
    });
    res.json(r);
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** Validate a schedule expression and preview the next fire time without
 *  creating a job. Useful for the UI / Telegram natural-language parser. */
jobsRouter.post("/preview", (req, res) => {
  const schedule = String(req.body?.schedule ?? "");
  try {
    const next = computeNextRun(schedule);
    res.json({ ok: true, next_run_at: next ? next.toISOString() : null });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg });
  }
});
