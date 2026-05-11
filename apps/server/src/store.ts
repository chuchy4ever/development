import type {
  Agent,
  Project,
  ProjectWithRepos,
  Repo,
  Run,
  Ticket,
  WorkflowDefinition,
} from "@ceo/shared";
import { db } from "./db.js";
import { safeParseJson } from "./jsonUtil.js";

// --- Raw row shapes (column-for-column from SQLite) -----------------------

interface ProjectRow {
  id: string;
  name: string;
  key_prefix: string;
  description: string;
  spec_md: string;
  tech_stack_md: string;
  workflow_json: string;
  daily_cost_cap_usd: number | null;
  created_at: string;
  updated_at: string;
}

interface RepoRow {
  id: string;
  project_id: string;
  name: string;
  url: string;
  local_path: string;
  default_branch: string;
  created_at: string;
}

interface TicketRow {
  id: string;
  project_id: string;
  ticket_key: string | null;
  title: string;
  body: string;
  status: string;
  priority: string | null;
  workflow_template: string | null;
  repos_touched: string;   // JSON
  depends_on: string;      // JSON
  parent_ticket_id: string | null;
  triage_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  role: string;
  category: string;
  system_prompt: string;
  model: string | null;
  allowed_tools_json: string | null;
  template_key: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  project_id: string;
  ticket_id: string;
  branch: string;
  status: string;
  agent_role: string;
  current_agent_name: string | null;
  current_phase_id: string | null;
  worktrees: string;       // JSON
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  total_cost_usd: number | null;
  user_verdict: string | null;
  user_verdict_at: string | null;
  user_verdict_note: string | null;
  created_at: string;
}

// --- Mappers ---------------------------------------------------------------

const parseJson = safeParseJson;

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  key_prefix: r.key_prefix || "",
  description: r.description,
  spec_md: r.spec_md,
  tech_stack_md: r.tech_stack_md,
  workflow: parseWorkflow(r.workflow_json),
  daily_cost_cap_usd: r.daily_cost_cap_usd ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export function todaysCostForProject(projectId: string): number {
  // Sum from runs.total_cost_usd (Director + sub-agent + run-context bumps
  // from CTO / Memory Curator) AND from cost_log entries that aren't tied to
  // a run (Triage, extract-from-spec, review_pr). cost_log entries with a
  // run_id are already reflected in runs.total_cost_usd via recordCost — so
  // we filter `run_id IS NULL` to avoid double-counting.
  const runs = db
    .prepare(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS s
        FROM runs
       WHERE project_id = ?
         AND date(created_at) = date('now')
    `)
    .get(projectId) as { s: number };
  const extras = db
    .prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS s
        FROM cost_log
       WHERE project_id = ?
         AND run_id IS NULL
         AND date(created_at) = date('now')
    `)
    .get(projectId) as { s: number };
  return (runs.s || 0) + (extras.s || 0);
}

function parseWorkflow(s: string | null | undefined): WorkflowDefinition {
  if (!s || !s.trim()) return { phases: [] };
  try {
    const parsed = JSON.parse(s) as WorkflowDefinition;
    if (!parsed || !Array.isArray(parsed.phases)) return { phases: [] };
    return parsed;
  } catch {
    return { phases: [] };
  }
}

export const toAgent = (r: AgentRow): Agent => {
  const base: Agent = {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    role: r.role as Agent["role"],
    category: r.category || "Development",
    system_prompt: r.system_prompt,
    model: r.model,
    allowed_tools: r.allowed_tools_json ? safeParseJson<string[] | null>(r.allowed_tools_json, null) : null,
    template_key: r.template_key ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  // Library overlay: when an agent is sourced from a global Skill template,
  // mirror the current template's prompt/role/model/tools onto the project's
  // agent. Edits to the template in admin propagate to every project on the
  // next read. Local DB row is still the fallback when the template was
  // deleted from the library.
  if (r.template_key) {
    try {
      // Lazy require to avoid a cyclic import at module load time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getAgentTemplate } = require("./agentTemplates.js") as typeof import("./agentTemplates.js");
      const tpl = getAgentTemplate(r.template_key);
      if (tpl) {
        base.role = tpl.role;
        base.system_prompt = tpl.system_prompt;
        base.model = tpl.model ?? base.model;
        base.allowed_tools = tpl.allowed_tools ?? base.allowed_tools;
        // Keep the agent's local name/category — those identify the slot
        // inside the project even if the template gets renamed in admin.
      }
    } catch { /* template loader unavailable / template missing — fall back to local fields */ }
  }
  return base;
};

export const toRepo = (r: RepoRow): Repo => ({
  id: r.id,
  project_id: r.project_id,
  name: r.name,
  url: r.url,
  local_path: r.local_path,
  default_branch: r.default_branch,
  created_at: r.created_at,
});

export const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  project_id: r.project_id,
  ticket_key: r.ticket_key,
  title: r.title,
  body: r.body,
  status: r.status as Ticket["status"],
  priority: (r.priority as Ticket["priority"]) ?? null,
  workflow_template: (r.workflow_template as Ticket["workflow_template"]) ?? null,
  repos_touched: parseJson<string[]>(r.repos_touched, []),
  depends_on: parseJson<string[]>(r.depends_on, []),
  parent_ticket_id: r.parent_ticket_id,
  triage_notes: r.triage_notes,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export const toRun = (r: RunRow): Run => ({
  id: r.id,
  project_id: r.project_id,
  ticket_id: r.ticket_id,
  branch: r.branch,
  status: r.status as Run["status"],
  agent_role: r.agent_role,
  current_agent_name: r.current_agent_name ?? null,
  current_phase_id: r.current_phase_id ?? null,
  worktrees: parseJson<Run["worktrees"]>(r.worktrees, []),
  started_at: r.started_at,
  finished_at: r.finished_at,
  exit_code: r.exit_code,
  error: r.error,
  total_cost_usd: r.total_cost_usd,
  user_verdict: (r.user_verdict as Run["user_verdict"]) ?? null,
  user_verdict_at: r.user_verdict_at ?? null,
  user_verdict_note: r.user_verdict_note ?? null,
  created_at: r.created_at,
});

// --- Loaders ---------------------------------------------------------------

export function loadProject(id: string): Project | null {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export function loadProjectWithRepos(id: string): ProjectWithRepos | null {
  const project = loadProject(id);
  if (!project) return null;
  const repoRows = db
    .prepare("SELECT * FROM repos WHERE project_id = ? ORDER BY created_at")
    .all(id) as RepoRow[];
  const agentRows = db
    .prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at")
    .all(id) as AgentRow[];
  return {
    ...project,
    repos: repoRows.map(toRepo),
    agents: agentRows.map(toAgent),
  };
}

export function listAgents(projectId: string): Agent[] {
  const rows = db
    .prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at")
    .all(projectId) as AgentRow[];
  return rows.map(toAgent);
}

export function loadAgent(id: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function listProjects(): Project[] {
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY created_at DESC")
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function loadTicket(id: string): Ticket | null {
  const row = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;
  return row ? toTicket(row) : null;
}

export function listTicketsForProject(projectId: string): Ticket[] {
  const rows = db
    .prepare("SELECT * FROM tickets WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as TicketRow[];
  return rows.map(toTicket);
}

export function loadRun(id: string): Run | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function listRunsForTicket(ticketId: string): Run[] {
  const rows = db
    .prepare("SELECT * FROM runs WHERE ticket_id = ? ORDER BY created_at DESC")
    .all(ticketId) as RunRow[];
  return rows.map(toRun);
}

export function listActiveRunsForProject(projectId: string): Run[] {
  const rows = db
    .prepare(
      `SELECT * FROM runs
        WHERE project_id = ? AND status IN ('pending', 'running')
        ORDER BY created_at DESC`,
    )
    .all(projectId) as RunRow[];
  return rows.map(toRun);
}
