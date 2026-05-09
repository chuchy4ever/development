import { Router } from "express";
import { nanoid } from "nanoid";
import path from "node:path";
import { db, nowIso } from "../db.js";
import { PROJECTS_DIR } from "../config.js";
import { gitClone, detectDefaultBranch, looksLikeGitUrl, ensureGitRepo } from "../git.js";
import fs from "node:fs";
import os from "node:os";
import { listProjects, loadProjectWithRepos } from "../store.js";
import { deleteRunsForTicket } from "../runs.js";
import type { WorkflowDefinition } from "@ceo/shared";
import { normalizePhase } from "@ceo/shared";
import { validateTaskConfig } from "../tasks/index.js";
import { defaultWorkflowForProject, ensureDefaultAgents } from "../seedAgents.js";
import { readMemory, writeMemory } from "../projectMemory.js";
import { computeKeyPrefix } from "../ticketKey.js";
import type { CreateProjectInput, CreateRepoInput } from "@ceo/shared";

export const projectsRouter = Router();

projectsRouter.get("/", (_req, res) => {
  res.json(listProjects());
});

projectsRouter.post("/", (req, res) => {
  const input = req.body as CreateProjectInput;
  if (!input?.name?.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const id = nanoid(10);
  const now = nowIso();
  const trimmedName = input.name.trim();
  db.prepare(
    `INSERT INTO projects (id, name, key_prefix, next_ticket_seq, description, spec_md, tech_stack_md, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    trimmedName,
    computeKeyPrefix(trimmedName),
    input.description ?? "",
    input.spec_md ?? "",
    input.tech_stack_md ?? "",
    now,
    now,
  );
  ensureDefaultAgents(id);
  db.prepare(`UPDATE projects SET workflow_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(defaultWorkflowForProject(id)), nowIso(), id);
  res.status(201).json(loadProjectWithRepos(id));
});

projectsRouter.get("/:id", (req, res) => {
  const project = loadProjectWithRepos(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(project);
});

projectsRouter.patch("/:id", (req, res) => {
  if (!loadProjectWithRepos(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  const input = req.body as Partial<CreateProjectInput>;
  // daily_cost_cap_usd: explicit null clears, undefined keeps existing
  const capUpdate = input.daily_cost_cap_usd === undefined
    ? "" : ", daily_cost_cap_usd = ?";
  const params: any[] = [
    input.name ?? null,
    input.description ?? null,
    input.spec_md ?? null,
    input.tech_stack_md ?? null,
  ];
  if (input.daily_cost_cap_usd !== undefined) params.push(input.daily_cost_cap_usd);
  params.push(nowIso(), req.params.id);
  db.prepare(
    `UPDATE projects
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           spec_md = COALESCE(?, spec_md),
           tech_stack_md = COALESCE(?, tech_stack_md)${capUpdate},
           updated_at = ?
     WHERE id = ?`,
  ).run(...params);
  res.json(loadProjectWithRepos(req.params.id));
});

projectsRouter.delete("/:id", async (req, res) => {
  const project = loadProjectWithRepos(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const ticketIds = (
    db.prepare("SELECT id FROM tickets WHERE project_id = ?").all(req.params.id) as { id: string }[]
  ).map((t) => t.id);
  await Promise.all(ticketIds.map((id) => deleteRunsForTicket(id)));
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

projectsRouter.post("/:id/repos", async (req, res) => {
  if (!loadProjectWithRepos(req.params.id)) {
    return res.status(404).json({ error: "project not found" });
  }
  const input = req.body as CreateRepoInput;
  if (!input?.name?.trim() || !input?.url?.trim()) {
    return res.status(400).json({ error: "name and url are required" });
  }
  const source = input.url.trim();

  let localPath: string;
  try {
    if (looksLikeGitUrl(source)) {
      // Remote URL — clone into our managed area.
      localPath = path.join(PROJECTS_DIR, req.params.id, "repos", input.name.trim());
      await gitClone(source, localPath);
    } else {
      // Local path — use it directly. Expand ~ and resolve to absolute.
      const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
      localPath = path.resolve(expanded);
      if (!fs.existsSync(localPath)) {
        return res.status(400).json({ error: `path does not exist: ${localPath}` });
      }
      if (!fs.statSync(localPath).isDirectory()) {
        return res.status(400).json({ error: `not a directory: ${localPath}` });
      }
      // Auto-init if not yet a git repo (so worktrees work).
      try {
        await ensureGitRepo(localPath);
      } catch (err: any) {
        return res.status(400).json({ error: `git init failed: ${err.message ?? err}` });
      }
    }
  } catch (err: any) {
    return res.status(400).json({ error: `setup failed: ${err.message ?? err}` });
  }

  const detected = await detectDefaultBranch(localPath);
  db.prepare(
    `INSERT INTO repos (id, project_id, name, url, local_path, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nanoid(10),
    req.params.id,
    input.name.trim(),
    source,
    localPath,
    input.default_branch ?? detected,
    nowIso(),
  );
  res.status(201).json(loadProjectWithRepos(req.params.id));
});

projectsRouter.get("/:id/workflow", (req, res) => {
  const project = loadProjectWithRepos(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(project.workflow);
});

projectsRouter.put("/:id/workflow", (req, res) => {
  const project = loadProjectWithRepos(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const wf = req.body as WorkflowDefinition;
  if (!wf || !Array.isArray(wf.phases)) {
    return res.status(400).json({ error: "phases array is required" });
  }
  const phaseIds = new Set(wf.phases.map((p) => p.id));
  if (phaseIds.size !== wf.phases.length) {
    return res.status(400).json({ error: "phase ids must be unique" });
  }
  const agentIds = new Set(project.agents.map((a) => a.id));
  // Normalize legacy command phases first so validation only deals with the
  // current shape ({kind:"task", task:{type,config}} or {kind:"agent",…}).
  wf.phases = wf.phases.map(normalizePhase);
  for (const p of wf.phases) {
    if (p.kind === "task") {
      if (!p.task || typeof p.task.type !== "string" || !p.task.type) {
        return res.status(400).json({
          error: `task phase "${p.id}" is missing task.type`,
        });
      }
      const cfgErr = validateTaskConfig(p.task.type, p.task.config ?? {});
      if (cfgErr) {
        return res.status(400).json({ error: `phase "${p.id}": ${cfgErr}` });
      }
    } else if (p.kind === "approval") {
      // No config required; message is optional.
      if (p.approval && p.approval.message !== undefined && p.approval.message !== null && typeof p.approval.message !== "string") {
        return res.status(400).json({ error: `approval phase "${p.id}" message must be a string` });
      }
    } else if (p.kind === "director") {
      // Director phase config is optional. All fields have defaults.
      if (p.director && typeof p.director !== "object") {
        return res.status(400).json({ error: `director phase "${p.id}" config must be an object` });
      }
      if (p.director?.max_iterations !== undefined && (typeof p.director.max_iterations !== "number" || p.director.max_iterations <= 0)) {
        return res.status(400).json({ error: `director phase "${p.id}" max_iterations must be positive` });
      }
      if (p.director?.budget_usd !== undefined && (typeof p.director.budget_usd !== "number" || p.director.budget_usd <= 0)) {
        return res.status(400).json({ error: `director phase "${p.id}" budget_usd must be positive` });
      }
    } else {
      if (!p.agent_id || !agentIds.has(p.agent_id)) {
        return res.status(400).json({
          error: `phase "${p.id}" references unknown agent "${p.agent_id}"`,
        });
      }
    }
    if (p.retry_target && !phaseIds.has(p.retry_target)) {
      return res.status(400).json({
        error: `phase "${p.id}" retry_target "${p.retry_target}" does not exist`,
      });
    }
    if (p.next && !phaseIds.has(p.next)) {
      return res.status(400).json({
        error: `phase "${p.id}" next "${p.next}" does not exist`,
      });
    }
    if (p.routes) {
      for (const [key, target] of Object.entries(p.routes)) {
        if (!phaseIds.has(target)) {
          return res.status(400).json({
            error: `phase "${p.id}" route "${key}" → "${target}" does not exist`,
          });
        }
      }
    }
  }
  // Validate Teams (optional). Names unique, ids unique, agent_names must
  // resolve to actual project agents.
  if (wf.teams) {
    if (!Array.isArray(wf.teams)) {
      return res.status(400).json({ error: "teams must be an array" });
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    const agentNames = new Set(project.agents.map((a) => a.name));
    for (const t of wf.teams) {
      if (!t.id || typeof t.id !== "string") {
        return res.status(400).json({ error: "team id is required" });
      }
      if (ids.has(t.id)) return res.status(400).json({ error: `duplicate team id "${t.id}"` });
      ids.add(t.id);
      if (!t.name || typeof t.name !== "string") {
        return res.status(400).json({ error: `team "${t.id}" name is required` });
      }
      if (names.has(t.name)) return res.status(400).json({ error: `duplicate team name "${t.name}"` });
      names.add(t.name);
      if (!Array.isArray(t.agent_names)) {
        return res.status(400).json({ error: `team "${t.name}" agent_names must be an array` });
      }
      for (const n of t.agent_names) {
        if (typeof n !== "string" || !agentNames.has(n)) {
          return res.status(400).json({ error: `team "${t.name}" references unknown agent "${n}"` });
        }
      }
    }
  }
  // Validate named Playbooks (optional). Each must have a unique name and
  // every step must reference an existing phase id.
  if (wf.playbooks) {
    if (!Array.isArray(wf.playbooks)) {
      return res.status(400).json({ error: "playbooks must be an array" });
    }
    const seen = new Set<string>();
    for (const pb of wf.playbooks) {
      if (!pb.name || typeof pb.name !== "string") {
        return res.status(400).json({ error: "playbook name is required" });
      }
      if (seen.has(pb.name)) {
        return res.status(400).json({ error: `duplicate playbook name "${pb.name}"` });
      }
      seen.add(pb.name);
      if (!Array.isArray(pb.steps) || pb.steps.length === 0) {
        return res.status(400).json({ error: `playbook "${pb.name}" must have at least one step` });
      }
      for (const step of pb.steps) {
        if (!step.phase_id || !phaseIds.has(step.phase_id)) {
          return res.status(400).json({
            error: `playbook "${pb.name}" references unknown phase "${step.phase_id}"`,
          });
        }
      }
    }
  }
  db.prepare(`UPDATE projects SET workflow_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(wf), nowIso(), req.params.id);
  res.json(loadProjectWithRepos(req.params.id)!.workflow);
});

projectsRouter.post("/:id/workflow/reset", (req, res) => {
  if (!loadProjectWithRepos(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  ensureDefaultAgents(req.params.id);
  const fresh = defaultWorkflowForProject(req.params.id);
  db.prepare(`UPDATE projects SET workflow_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(fresh), nowIso(), req.params.id);
  res.json(fresh);
});

projectsRouter.get("/:id/memory", (req, res) => {
  if (!loadProjectWithRepos(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json({ content: readMemory(req.params.id) });
});

projectsRouter.put("/:id/memory", (req, res) => {
  if (!loadProjectWithRepos(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  writeMemory(req.params.id, content);
  res.json({ content });
});

projectsRouter.get("/:id/stats", (req, res) => {
  if (!loadProjectWithRepos(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  const projectId = req.params.id;
  // Aggregate everything in SQL — for projects with thousands of runs,
  // streaming all rows and reducing in JS doesn't scale.
  const todayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const sevenDaysIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const nowIsoStr = new Date().toISOString();

  const agg = db.prepare(`
    SELECT
      COUNT(*) AS runs_total,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN total_cost_usd ELSE 0 END), 0) AS today_cost_usd,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN total_cost_usd ELSE 0 END), 0) AS last_7_days_cost_usd,
      COALESCE(
        SUM(
          CASE WHEN started_at IS NOT NULL THEN
            (julianday(COALESCE(finished_at, ?)) - julianday(started_at)) * 86400000
          ELSE 0 END
        ), 0
      ) AS total_runtime_ms
    FROM runs
    WHERE project_id = ?
  `).get(todayIso, sevenDaysIso, nowIsoStr, projectId) as {
    runs_total: number;
    total_cost_usd: number;
    today_cost_usd: number;
    last_7_days_cost_usd: number;
    total_runtime_ms: number;
  };

  const runsByStatusRows = db.prepare(
    `SELECT status, COUNT(*) AS cnt FROM runs WHERE project_id = ? GROUP BY status`,
  ).all(projectId) as { status: string; cnt: number }[];
  const runs_by_status: Record<string, number> = {};
  for (const r of runsByStatusRows) runs_by_status[r.status] = r.cnt;

  const ticketsByStatusRows = db.prepare(
    `SELECT status, COUNT(*) AS cnt FROM tickets WHERE project_id = ? GROUP BY status`,
  ).all(projectId) as { status: string; cnt: number }[];
  const tickets_by_status: Record<string, number> = {};
  for (const t of ticketsByStatusRows) tickets_by_status[t.status] = t.cnt;
  const tickets_total = ticketsByStatusRows.reduce((s, r) => s + r.cnt, 0);

  const succeeded = runs_by_status.succeeded ?? 0;

  res.json({
    runs_total: agg.runs_total,
    runs_by_status,
    total_cost_usd: +agg.total_cost_usd.toFixed(4),
    today_cost_usd: +agg.today_cost_usd.toFixed(4),
    last_7_days_cost_usd: +agg.last_7_days_cost_usd.toFixed(4),
    total_runtime_ms: Math.round(agg.total_runtime_ms),
    avg_cost_per_run_usd: agg.runs_total > 0 ? +(agg.total_cost_usd / agg.runs_total).toFixed(4) : 0,
    tickets_by_status,
    tickets_total,
    estimated_saved_hours: +(succeeded * 1.5).toFixed(1),
  });
});

projectsRouter.delete("/:id/repos/:repoId", (req, res) => {
  const info = db
    .prepare("DELETE FROM repos WHERE id = ? AND project_id = ?")
    .run(req.params.repoId, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "not found" });
  res.json(loadProjectWithRepos(req.params.id));
});
