import { nanoid } from "nanoid";
import type { AgentTemplate, WorkflowDefinition } from "@ceo/shared";
import { db, nowIso } from "./db.js";
import { AGENT_TEMPLATES, CORE_TEMPLATES } from "./defaultAgents.js";

function insertAgentFromTemplate(projectId: string, tpl: AgentTemplate): string {
  const id = nanoid(10);
  const now = nowIso();
  db.prepare(
    `INSERT INTO agents (id, project_id, name, role, category, system_prompt, model, allowed_tools_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    tpl.name,
    tpl.role,
    tpl.category,
    tpl.system_prompt,
    tpl.model,
    tpl.allowed_tools ? JSON.stringify(tpl.allowed_tools) : null,
    now,
    now,
  );
  return id;
}

/**
 * Ensure the project has the core auto-seed agents and that any existing
 * agent whose name matches a known template has the template's category.
 */
export function ensureDefaultAgents(projectId: string): boolean {
  const existing = db
    .prepare("SELECT id, name, category FROM agents WHERE project_id = ?")
    .all(projectId) as { id: string; name: string; category: string }[];
  const haveByName = new Map(existing.map((a) => [a.name, a]));
  let inserted = false;
  for (const tpl of CORE_TEMPLATES) {
    const existingAgent = haveByName.get(tpl.name);
    if (!existingAgent) {
      insertAgentFromTemplate(projectId, tpl);
      inserted = true;
      continue;
    }
    if (existingAgent.category !== tpl.category) {
      db.prepare(
        `UPDATE agents SET category = ?, updated_at = ? WHERE id = ?`,
      ).run(tpl.category, nowIso(), existingAgent.id);
    }
  }
  return inserted;
}

/**
 * Add a single template into the project. Returns inserted agent id, or null
 * if an agent with that name already exists.
 */
export function addAgentFromTemplate(projectId: string, key: string): string | null {
  const tpl = AGENT_TEMPLATES.find((t) => t.key === key);
  if (!tpl) throw new Error(`unknown template "${key}"`);
  const dup = db
    .prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = ?")
    .get(projectId, tpl.name);
  if (dup) return null;
  return insertAgentFromTemplate(projectId, tpl);
}

/**
 * Build a default workflow that puts the Junior/Senior pattern into use:
 *   Junior Coder → Senior Coder (retry → Junior) → Reviewer (retry → Junior) → Tester
 * Falls back gracefully when one of the agents isn't present.
 */
export function defaultWorkflowForProject(projectId: string): WorkflowDefinition {
  const rows = db
    .prepare("SELECT id, name, role FROM agents WHERE project_id = ? ORDER BY created_at")
    .all(projectId) as { id: string; name: string; role: string }[];
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  const firstByRole = new Map<string, string>();
  for (const r of rows) {
    if (!firstByRole.has(r.role)) firstByRole.set(r.role, r.id);
  }
  const junior = byName.get("Junior Coder") ?? byName.get("Coder") ?? firstByRole.get("coder");
  const senior = byName.get("Senior Coder");
  const reviewer = byName.get("Reviewer") ?? firstByRole.get("reviewer");
  const tester = byName.get("Tester") ?? firstByRole.get("tester");
  const closer = byName.get("Closer");

  const phases: WorkflowDefinition["phases"] = [];
  if (junior) {
    phases.push({
      id: "junior",
      agent_id: junior,
      next: senior ? "senior" : reviewer ? "reviewer" : tester ? "tester" : closer ? "closer" : null,
    });
  }
  // Senior is the FINISHER — no retry target, always continues forward.
  // Reviewer / Closer bounce back to Senior (not Junior) when they find issues.
  if (senior) {
    phases.push({
      id: "senior",
      agent_id: senior,
      next: reviewer ? "reviewer" : tester ? "tester" : closer ? "closer" : null,
    });
  }
  if (reviewer) {
    phases.push({
      id: "reviewer",
      agent_id: reviewer,
      next: tester ? "tester" : closer ? "closer" : null,
      retry_target: senior ? "senior" : null,
      max_attempts: 2,
    });
  }
  if (tester) {
    phases.push({
      id: "tester",
      agent_id: tester,
      next: closer ? "closer" : null,
      retry_target: senior ? "senior" : null,
      max_attempts: 2,
    });
  }
  // Note: a deterministic CI gate (kind="command") belongs in stack-specific
  // templates (e.g. PHP team) where we know the actual CI command. The
  // auto-seed has no idea what to run, so we don't insert one here.
  if (closer) {
    phases.push({
      id: "closer",
      agent_id: closer,
      next: null,
      retry_target: senior ? "senior" : null,
      max_attempts: 2,
    });
  }
  return { phases };
}

/**
 * Boot-time backfill: ensure every existing project has core agents and a
 * sensible workflow.
 */
export function backfillAllProjects() {
  const ids = db.prepare("SELECT id FROM projects").all() as { id: string }[];
  for (const { id } of ids) {
    ensureDefaultAgents(id);

    const row = db
      .prepare("SELECT workflow_json FROM projects WHERE id = ?")
      .get(id) as { workflow_json: string } | undefined;
    const wf = parseSafe(row?.workflow_json);
    // A phase is valid if it has either an agent_id (agent kind) OR a non-agent
    // kind (task / approval / legacy command). Earlier we required agent_id on
    // every phase, which wiped task phases on each boot.
    const hasInvalidPhase = (phases: any[]) =>
      phases.some((p: any) => {
        const kind = p.kind ?? "agent";
        if (kind === "agent") return !p.agent_id;
        return false;
      });
    if (!wf || !Array.isArray(wf.phases) || wf.phases.length === 0 || hasInvalidPhase(wf.phases)) {
      const fresh = defaultWorkflowForProject(id);
      db.prepare(`UPDATE projects SET workflow_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(fresh), nowIso(), id);
      continue;
    }
    const hasAnyNext = wf.phases.some((p: any) => p.next !== undefined);
    if (!hasAnyNext) {
      for (let i = 0; i < wf.phases.length; i++) {
        const p = wf.phases[i];
        const next = wf.phases[i + 1];
        p.next = next ? next.id : null;
      }
      db.prepare(`UPDATE projects SET workflow_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(wf), nowIso(), id);
    }
  }
}

function parseSafe(s: string | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
