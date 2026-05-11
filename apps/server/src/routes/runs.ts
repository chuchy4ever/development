import { Router } from "express";
import {
  listActiveRunsForProject,
  listRunsForTicket,
  loadProjectWithRepos,
  loadRun,
  loadTicket,
} from "../store.js";
import { cancelRun, decideApproval, deleteRun, listEvents, startRun, subscribeRun } from "../runs.js";
import { openPullRequests } from "../pr.js";
import { db, nowIso } from "../db.js";
import type { RunUserVerdict, SetRunVerdictInput } from "@ceo/shared";

export const runsRouter = Router({ mergeParams: true });

runsRouter.post("/projects/:projectId/tickets/:ticketId/runs", async (req, res) => {
  const project = loadProjectWithRepos(req.params.projectId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const ticket = loadTicket(req.params.ticketId);
  if (!ticket || ticket.project_id !== project.id) {
    return res.status(404).json({ error: "ticket not found" });
  }
  try {
    const runId = await startRun({ project, ticket });
    res.status(201).json(loadRun(runId));
  } catch (e: any) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

runsRouter.get("/runs/:runId", (req, res) => {
  const run = loadRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json(run);
});

runsRouter.get("/tickets/:ticketId/runs", (req, res) => {
  res.json(listRunsForTicket(req.params.ticketId));
});

runsRouter.get("/projects/:projectId/active-runs", (req, res) => {
  const runs = listActiveRunsForProject(req.params.projectId);
  res.json(runs.map((r) => {
    const ticket = loadTicket(r.ticket_id);
    return {
      run_id: r.id,
      ticket_id: r.ticket_id,
      ticket_key: ticket?.ticket_key ?? null,
      ticket_title: ticket?.title ?? "",
      status: r.status,
      agent_role: r.agent_role,
      current_agent_name: r.current_agent_name,
      current_phase_id: r.current_phase_id,
    };
  }));
});

runsRouter.post("/runs/:runId/cancel", (req, res) => {
  const ok = cancelRun(req.params.runId);
  if (!ok) return res.status(409).json({ error: "no running process for this run" });
  res.json(loadRun(req.params.runId));
});

runsRouter.post("/runs/:runId/approve", (req, res) => {
  const note = (req.body as any)?.note as string | undefined;
  const ok = decideApproval(req.params.runId, true, note);
  if (!ok) return res.status(409).json({ error: "run is not awaiting approval" });
  res.json(loadRun(req.params.runId));
});

runsRouter.post("/runs/:runId/reject", (req, res) => {
  const note = (req.body as any)?.note as string | undefined;
  const ok = decideApproval(req.params.runId, false, note);
  if (!ok) return res.status(409).json({ error: "run is not awaiting approval" });
  res.json(loadRun(req.params.runId));
});

/** Set / clear a user verdict on a finished run. Idempotent — re-rating
 *  overwrites. Verdict is consumed by Memory Curator (good runs become
 *  positive examples, bad/broken_in_prod become anti-patterns) on the next
 *  Director run in the same project. */
runsRouter.put("/runs/:runId/verdict", (req, res) => {
  const run = loadRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  if (run.status === "running" || run.status === "pending" || run.status === "awaiting_approval") {
    return res.status(409).json({ error: `cannot rate a ${run.status} run` });
  }
  const body = req.body as SetRunVerdictInput;
  const verdict = body?.verdict ?? null;
  if (verdict !== null && !["good", "bad", "broken_in_prod"].includes(verdict)) {
    return res.status(400).json({ error: 'verdict must be "good" | "bad" | "broken_in_prod" | null' });
  }
  const note = typeof body?.note === "string" ? body.note.slice(0, 1000) : null;
  db.prepare(
    `UPDATE runs SET user_verdict = ?, user_verdict_at = ?, user_verdict_note = ? WHERE id = ?`,
  ).run(verdict, verdict ? nowIso() : null, note, req.params.runId);
  res.json(loadRun(req.params.runId));
  // Touch verdict so TS sees it used (no-op).
  void (verdict as RunUserVerdict | null);
});

runsRouter.delete("/runs/:runId", async (req, res) => {
  const ok = await deleteRun(req.params.runId);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

runsRouter.post("/runs/:runId/pr", async (req, res) => {
  try {
    const results = await openPullRequests(req.params.runId);
    res.json(results);
  } catch (e: any) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

runsRouter.get("/runs/:runId/events", (req, res) => {
  const since = Number(req.query.since ?? 0);
  res.json(listEvents(req.params.runId, isNaN(since) ? 0 : since));
});

runsRouter.get("/runs/:runId/stream", (req, res) => {
  const runId = req.params.runId;
  if (!loadRun(runId)) return res.status(404).json({ error: "not found" });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (ev: any) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

  const since = Number(req.query.since ?? 0);
  for (const ev of listEvents(runId, isNaN(since) ? 0 : since)) send(ev);

  const unsub = subscribeRun(runId, send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });
});
