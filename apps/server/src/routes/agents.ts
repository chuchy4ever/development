import { Router } from "express";
import { nanoid } from "nanoid";
import { db, nowIso } from "../db.js";
import { listAgents, loadAgent, loadProjectWithRepos } from "../store.js";
import {
  getAgentTemplate,
  isBuiltin,
  isUserOverride,
  listAgentTemplates,
  resetUserTemplate,
  saveAgentTemplate,
} from "../agentTemplates.js";
import { addAgentFromTemplate } from "../seedAgents.js";
import { deleteAgentMemory, readAgentMemory, writeAgentMemory } from "../agentMemory.js";
import type { AgentRole, AgentTemplate, CreateAgentInput } from "@ceo/shared";

export const agentsRouter = Router({ mergeParams: true });
export const agentTemplatesRouter = Router();

const ROLES: AgentRole[] = ["coder", "reviewer", "tester"];

function projectIdFrom(req: { params: Record<string, string | undefined> }): string {
  return req.params.projectId!;
}

// Project-scoped agent CRUD --------------------------------------------------

agentsRouter.get("/", (req, res) => {
  res.json(listAgents(projectIdFrom(req)));
});

agentsRouter.post("/", (req, res) => {
  const projectId = projectIdFrom(req);
  if (!loadProjectWithRepos(projectId)) {
    return res.status(404).json({ error: "project not found" });
  }
  const input = req.body as CreateAgentInput;
  if (!input?.name?.trim() || !input?.role || !input?.system_prompt?.trim()) {
    return res.status(400).json({ error: "name, role, and system_prompt are required" });
  }
  if (!ROLES.includes(input.role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
  }
  const id = nanoid(10);
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO agents
         (id, project_id, name, role, category, system_prompt, model, allowed_tools_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      input.name.trim(),
      input.role,
      (input.category && input.category.trim()) || "Development",
      input.system_prompt,
      input.model ?? null,
      input.allowed_tools ? JSON.stringify(input.allowed_tools) : null,
      now,
      now,
    );
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "an agent with that name already exists in this project" });
    }
    throw e;
  }
  res.status(201).json(loadAgent(id));
});

agentsRouter.patch("/:id", (req, res) => {
  const agent = loadAgent(req.params.id);
  if (!agent || agent.project_id !== projectIdFrom(req)) {
    return res.status(404).json({ error: "not found" });
  }
  // Library-locked agents: editing the prompt/model/tools/role belongs in
  // admin so changes propagate. Allow per-project tweaks of name/category
  // only — those are slot-level metadata, not the specialist's definition.
  if (agent.template_key) {
    const input = req.body as Partial<CreateAgentInput>;
    const allowedKeys = new Set(["name", "category"]);
    const blocked = Object.keys(input).filter((k) => !allowedKeys.has(k));
    if (blocked.length > 0) {
      return res.status(409).json({
        error: `agent "${agent.name}" is from the global library (template "${agent.template_key}"). Edit ${blocked.join(", ")} in Admin → Skill templates so the change propagates to all projects.`,
      });
    }
  }
  const input = req.body as Partial<CreateAgentInput>;
  if (input.role && !ROLES.includes(input.role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
  }
  db.prepare(
    `UPDATE agents
       SET name = COALESCE(?, name),
           role = COALESCE(?, role),
           category = COALESCE(?, category),
           system_prompt = COALESCE(?, system_prompt),
           model = ?,
           allowed_tools_json = ?,
           updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.role ?? null,
    input.category ?? null,
    input.system_prompt ?? null,
    input.model === undefined ? agent.model : input.model,
    input.allowed_tools === undefined
      ? (agent.allowed_tools ? JSON.stringify(agent.allowed_tools) : null)
      : input.allowed_tools === null
        ? null
        : JSON.stringify(input.allowed_tools),
    nowIso(),
    req.params.id,
  );
  res.json(loadAgent(req.params.id));
});

agentsRouter.delete("/:id", (req, res) => {
  const agent = loadAgent(req.params.id);
  if (!agent || agent.project_id !== projectIdFrom(req)) {
    return res.status(404).json({ error: "not found" });
  }
  const projectRow = db
    .prepare("SELECT workflow_json FROM projects WHERE id = ?")
    .get(agent.project_id) as { workflow_json: string } | undefined;
  if (projectRow?.workflow_json) {
    try {
      const wf = JSON.parse(projectRow.workflow_json);
      if (Array.isArray(wf.phases) && wf.phases.some((p: any) => p.agent_id === agent.id)) {
        return res.status(409).json({
          error: "cannot delete: this agent is referenced by the workflow. Remove the phase first.",
        });
      }
    } catch {}
  }
  db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
  deleteAgentMemory(agent.project_id, agent.id);
  res.status(204).end();
});

agentsRouter.get("/:id/memory", (req, res) => {
  const agent = loadAgent(req.params.id);
  if (!agent || agent.project_id !== projectIdFrom(req)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json({ content: readAgentMemory(agent.project_id, agent.id) });
});

agentsRouter.put("/:id/memory", (req, res) => {
  const agent = loadAgent(req.params.id);
  if (!agent || agent.project_id !== projectIdFrom(req)) {
    return res.status(404).json({ error: "not found" });
  }
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  writeAgentMemory(agent.project_id, agent.id, content);
  res.json({ content });
});

// Add from template
agentsRouter.post("/from-template/:key", (req, res) => {
  const projectId = projectIdFrom(req);
  if (!loadProjectWithRepos(projectId)) {
    return res.status(404).json({ error: "project not found" });
  }
  let id: string | null;
  try {
    id = addAgentFromTemplate(projectId, req.params.key);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  if (!id) {
    return res.status(409).json({ error: "an agent with that template name already exists" });
  }
  res.status(201).json(loadAgent(id));
});

// Global template catalog ----------------------------------------------------

agentTemplatesRouter.get("/", (_req, res) => {
  // Annotate each entry with its origin so the admin UI can show a
  // "user-customized" / "built-in" / "user-defined" badge.
  const list = listAgentTemplates().map((t) => ({
    ...t,
    is_builtin: isBuiltin(t.key),
    is_user_override: isUserOverride(t.key),
  }));
  res.json(list);
});

agentTemplatesRouter.get("/:key", (req, res) => {
  const t = getAgentTemplate(req.params.key);
  if (!t) return res.status(404).json({ error: "template not found" });
  res.json({ ...t, is_builtin: isBuiltin(t.key), is_user_override: isUserOverride(t.key) });
});

agentTemplatesRouter.put("/:key", (req, res) => {
  const body = req.body as AgentTemplate;
  if (!body?.name?.trim() || !body?.role || !body?.system_prompt?.trim()) {
    return res.status(400).json({ error: "name, role, and system_prompt are required" });
  }
  if (!ROLES.includes(body.role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
  }
  const tpl: AgentTemplate = {
    key: req.params.key,
    name: body.name.trim(),
    role: body.role,
    category: body.category || "Development",
    description: body.description ?? "",
    system_prompt: body.system_prompt,
    model: body.model ?? null,
    allowed_tools: body.allowed_tools ?? null,
    default_notes: body.default_notes ?? null,
    default_skill_category: body.default_skill_category,
    core: body.core ?? false,
  };
  try {
    saveAgentTemplate(tpl);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  res.json(tpl);
});

agentTemplatesRouter.delete("/:key", (req, res) => {
  const removed = resetUserTemplate(req.params.key);
  if (!removed) return res.status(404).json({ error: "no user override to reset" });
  res.status(204).end();
});
