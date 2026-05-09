export type TicketStatus =
  | "inbox"
  | "backlog"
  | "running"
  | "review"
  | "done"
  | "blocked";

export type Priority = "P0" | "P1" | "P2" | "P3";

export type WorkflowTemplate = "feature" | "bugfix" | "change_request" | "spike";

export interface Repo {
  id: string;
  project_id: string;
  name: string;
  url: string;
  local_path: string;
  default_branch: string;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  key_prefix: string;
  description: string;
  spec_md: string;
  tech_stack_md: string;
  workflow: WorkflowDefinition;
  /** Per-project daily spend cap in USD; null = no cap. */
  daily_cost_cap_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface Ticket {
  id: string;
  project_id: string;
  ticket_key: string | null;
  title: string;
  body: string;
  status: TicketStatus;
  priority: Priority | null;
  workflow_template: WorkflowTemplate | null;
  repos_touched: string[];
  depends_on: string[];
  parent_ticket_id: string | null;
  triage_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithRepos extends Project {
  repos: Repo[];
  agents: Agent[];
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  spec_md?: string;
  tech_stack_md?: string;
  daily_cost_cap_usd?: number | null;
}

export interface CreateRepoInput {
  name: string;
  url: string;
  default_branch?: string;
}

export interface CreateTicketInput {
  title: string;
  body: string;
}

export interface BulkImportInput {
  markdown: string;
  auto_triage?: boolean;
}

export interface BulkImportResult {
  created: Ticket[];
  triaged: number;
}

export type SchedulerMode = "paused" | "running";

export interface SchedulerStatus {
  mode: SchedulerMode;
  active_runs: number;
  max_concurrent: number;
  queue_depth: number;
}

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Run {
  id: string;
  project_id: string;
  ticket_id: string;
  branch: string;
  status: RunStatus;
  agent_role: string;
  current_agent_name: string | null;
  current_phase_id: string | null;
  worktrees: { repo_name: string; path: string }[];
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  total_cost_usd: number | null;
  created_at: string;
}

/** Compact view of which agent is currently working on which ticket — used by the board. */
export interface ActiveRunSummary {
  run_id: string;
  ticket_id: string;
  ticket_key: string | null;
  ticket_title: string;
  status: RunStatus;
  agent_role: AgentRole | string;
  current_agent_name: string | null;
  current_phase_id: string | null;
}

export type RunEventType =
  | "system"            // orchestrator log line (start, worktree created, etc.)
  | "claude_stream"     // raw stream-json line from claude
  | "stdout"            // any other stdout chunk (rare)
  | "stderr"
  | "diff"              // computed diff per repo at end
  | "phase_start"       // entering a pipeline phase (coder/reviewer/tester/command)
  | "phase_end"         // phase finished — payload includes role + verdict
  | "command_start"     // command-phase: process spawned
  | "command_output"    // command-phase: stdout/stderr chunk
  | "command_end"       // command-phase: process exited
  | "awaiting_approval" // approval-phase: paused, needs user click
  | "director_start"    // director-phase: begun
  | "director_decision" // director-phase: turn decided
  | "director_thinking" // director-phase: streamed token delta from Director
  | "director_dispatch" // director-phase: sub-agent / ci_gate invoked
  | "director_subagent_done" // director-phase: sub-agent / ci_gate finished
  | "director_end"      // director-phase: terminated
  | "done";             // terminal event

export type AgentRole = "coder" | "reviewer" | "tester";

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: AgentRole;
  category: string;
  system_prompt: string;
  model: string | null;
  allowed_tools: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  name: string;
  role: AgentRole;
  category?: string;
  system_prompt: string;
  model?: string | null;
  allowed_tools?: string[] | null;
}

/** Auto-derive a phase's capability category from its kind / agent name+role.
 *  Used both by the editor (swimlane layout) and by Director (prompt grouping)
 *  whenever phase.category is not explicitly set. */
export function deriveSkillCategory(
  phase: WorkflowPhase,
  agent?: { name: string; role: AgentRole } | null,
): SkillCategory {
  if (phase.category) return phase.category;
  if (phase.kind === "task" || phase.kind === "command") return "validation";
  if (phase.kind === "approval") return "closing";
  if (!agent) return "general";
  // Name-based heuristics override role for specialists (a "Closer" is reviewer
  // role but conceptually closing; "Tech Lead" / "Architect" are coders but
  // conceptually planning; "DevOps Engineer" is infra).
  const n = agent.name.toLowerCase();
  if (n.includes("closer")) return "closing";
  if (n.includes("devops")) return "infra";
  if (n.includes("tech lead") || n.includes("architect") || n.includes("cto")) return "planning";
  if (n.includes("lint")) return "review";
  if (agent.role === "reviewer") return "review";
  if (agent.role === "tester") return "validation";
  if (agent.role === "coder") return "coding";
  return "general";
}

/** Display order for swimlanes — top to bottom, the way work tends to flow. */
export const SKILL_CATEGORY_ORDER: SkillCategory[] = [
  "planning",
  "infra",
  "coding",
  "review",
  "validation",
  "closing",
  "general",
];

export const SKILL_CATEGORY_LABEL: Record<SkillCategory, string> = {
  planning: "Planning",
  coding: "Coding",
  review: "Review",
  validation: "Validation (gates)",
  closing: "Closing",
  infra: "Infra",
  general: "General",
};

/** A pre-defined agent template the user can instantiate into a project. */
export interface AgentTemplate {
  key: string;                  // stable identifier
  name: string;
  role: AgentRole;
  category: string;
  description: string;          // 1-line, shown in template picker
  system_prompt: string;
  model: string | null;
  allowed_tools: string[] | null;
  /** If true, this template is auto-seeded into every new project. */
  core: boolean;
}

/** An agent definition baked into a workflow template (no project_id; agent_id resolved on apply). */
export interface AgentBundleEntry {
  name: string;
  role: AgentRole;
  category: string;
  system_prompt: string;
  model: string | null;
  allowed_tools: string[] | null;
}

/** Generic task config: deterministic, non-AI step (shell, notification, etc.). */
export interface PhaseTask {
  /** Registered task type. Currently: "shell" | "telegram". Extensible via server registry. */
  type: string;
  /** Type-specific configuration. Validated by the executor. */
  config: Record<string, unknown>;
}

/** Workflow phase as stored in a template — references agent by name, not id. */
export interface TemplatePhase {
  id: string;
  /** "agent" runs an AI agent. "task" runs a deterministic step (shell, telegram, …).
   *  Legacy: "command" maps to {kind:"task", task:{type:"shell", config:{…}}}. */
  kind?: "agent" | "task" | "command";
  /** Required when kind="agent". */
  agent_name?: string;
  /** Required when kind="task". */
  task?: PhaseTask;
  // ---- legacy command fields (still accepted on read, normalized to task.shell) ----
  command?: string;
  working_dir?: string | null;
  timeout_sec?: number;
  // ---- common ----
  next?: string | null;
  routes?: Record<string, string> | null;
  retry_target?: string | null;
  max_attempts?: number;
  notes?: string | null;
  position?: { x: number; y: number } | null;
}

/** Team bundled in a template. agent_names reference Agent.name within the
 *  preset's agents[] (or already-present project agents). On apply, missing
 *  agent references are silently dropped. */
export interface TemplateTeam {
  id: string;
  name: string;
  description?: string;
  category?: SkillCategory;
  agent_names: string[];
}

/** Playbook bundled in a template. Step phase_ids must match TemplatePhase.id
 *  values from the same preset (or already-present project phases). */
export interface TemplatePlaybook {
  name: string;
  description: string;
  steps: PlaybookStep[];
}

export interface WorkflowPreset {
  key: string;                  // stable identifier
  name: string;
  description: string;
  /** "builtin" = bundled in code; "user" = saved by user, lives in ~/.ceo/templates/. */
  source: "builtin" | "user";
  /** Agents this template needs. On apply, missing ones are inserted; existing ones are left alone. */
  agents: AgentBundleEntry[];
  phases: TemplatePhase[];
  /** Teams bundled with the template (optional — older templates omit this). */
  teams?: TemplateTeam[];
  /** Named Playbooks bundled with the template (optional). */
  playbooks?: TemplatePlaybook[];
  /** Director config defaults bundled with the template (optional). */
  director_config?: DirectorConfig | null;
  project_specifics?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ApplyTemplateResult {
  agents_added: number;
  agents_existing: number;
  phases: number;
  teams_added?: number;
  playbooks_added?: number;
}

/** Category groups skills/gates by what they DO, independent of execution order.
 *  Director sees them grouped by category in its prompt; the editor lays them
 *  out in swimlanes. Auto-derived from agent role/name when not set. */
export type SkillCategory =
  | "planning"   // Tech Lead, Architect — design / decompose
  | "coding"     // Junior, Senior, Coder — write code
  | "review"     // Reviewer, Lint Gate — assess quality
  | "validation" // ci_gate, tests — deterministic checks (gates)
  | "closing"    // Closer, deploy, approval — finalize
  | "infra"      // DevOps — environment / pipeline
  | "general";

export interface WorkflowPhase {
  id: string;
  /**
   * "agent" runs an AI agent (default — omit for back-compat).
   * "task" runs a deterministic, non-AI step dispatched to a server-side
   * executor by `task.type`. Legacy "command" is auto-normalized to a task.
   * "approval" pauses the run until a user explicitly approves or rejects
   * via API (human-in-the-loop gate).
   */
  kind?: "agent" | "task" | "command" | "approval" | "director";
  /** Capability group (planning / coding / review / validation / closing / infra).
   *  Director uses this to organize the playbook by what each skill does, not
   *  the order of `next` edges. Auto-derived if absent. */
  category?: SkillCategory;
  /** Required when kind="agent". Reference to an agent in the same project. */
  agent_id?: string;
  /** Required when kind="task". */
  task?: PhaseTask;
  /** Optional config for kind="approval". */
  approval?: {
    /** Markdown message shown to the approver. */
    message?: string | null;
  };
  /** Optional config for kind="director" (see director-pattern branch).
   *  Director phase replaces the static graph with a Claude-driven dispatcher
   *  that picks sub-agents turn-by-turn. Skeleton only on the director-pattern
   *  branch; not wired into the engine yet. */
  director?: {
    /** Project-specific brief appended to Director's system prompt. */
    project_brief?: string | null;
    /** Hard guard against runaway loops. Default 12. */
    max_iterations?: number;
    /** Total budget in USD across Director + sub-agents. Default 8. */
    budget_usd?: number;
    /** Subset of project agents Director may dispatch (by name). Default: all. */
    available_subagents?: string[];
  };
  // ---- legacy command fields (read-shim only; new writes use task.shell) ----
  command?: string;
  working_dir?: string | null;
  timeout_sec?: number;
  // ---- common ----
  /** Default next phase when this one succeeds (and no route matches). null = workflow ends. */
  next?: string | null;
  /** Conditional routing: if the phase's verdict has `route: <key>` and this map
   *  contains that key, the engine jumps to routes[key] instead of `next`. */
  routes?: Record<string, string> | null;
  /** If this phase produces a verdict with ok=false, jump to this phase id and re-run forward. */
  retry_target?: string | null;
  /** Max attempts for the *retry loop ending at this phase*. Default 2. */
  max_attempts?: number;
  /** Phase-specific notes appended to the agent's prompt for this run. */
  notes?: string | null;
  /** Saved canvas position for the workflow editor. */
  position?: { x: number; y: number } | null;
}

/** Project-level Director configuration. Director is the implicit orchestrator
 *  that runs every workflow as a playbook — it is not a phase in the graph. */
export interface DirectorConfig {
  /** Project-specific brief appended to Director's system prompt. */
  project_brief?: string | null;
  /** Hard guard against runaway loops. Default 12. */
  max_iterations?: number;
  /** Total budget in USD across Director + sub-agents. Default 8. */
  budget_usd?: number;
  /** Subset of project agents Director may dispatch (by name). Default: all (minus blacklist). */
  available_subagents?: string[];
  /** Override CI command for run_ci_gate; falls back to a workflow phase named "ci_gate". */
  ci_gate_command?: string;
  ci_gate_timeout_sec?: number;
}

/** A Team is a lightweight grouping of agents that solve a class of problem
 *  together (dev-team, review-team, infra-team, security, qa, …). Teams are
 *  for Director's mental model and prompt clarity — they don't constrain
 *  execution. An agent can belong to zero, one, or many teams. */
export interface Team {
  /** Unique within a workflow. */
  id: string;
  /** Display name (e.g. "Dev Team", "Security"). */
  name: string;
  /** When does Director reach for this team? */
  description?: string;
  /** Capability category — used for organization in the editor and in Director's prompt. */
  category?: SkillCategory;
  /** Names of agents on this team. References Agent.name within the project. */
  agent_names: string[];
}

/** Step within a named Playbook — a reference to a skill/gate (phase) the
 *  Playbook walks in order. Director executes them sequentially when invoking
 *  the Playbook, with optional per-step note overrides. */
export interface PlaybookStep {
  /** Phase id from WorkflowDefinition.phases. */
  phase_id: string;
  /** Optional addendum appended to the phase's notes for this Playbook only. */
  notes_override?: string | null;
  /** If true, Director may skip this step when its judgement says it's not
   *  needed (e.g. an extra reviewer pass on a trivial change). Default false. */
  optional?: boolean;
}

/** A named recipe Director can pick to solve a class of problem. Bundles an
 *  ordered list of skills + gates with a "when to use" rule. Director sees
 *  the Playbook registry in its system prompt and may dispatch one via the
 *  use_playbook action. */
export interface Playbook {
  /** Unique within a workflow. */
  name: string;
  /** When to use this Playbook — read by Director when picking. */
  description: string;
  /** Ordered steps. Each step references a phase id from workflow.phases. */
  steps: PlaybookStep[];
}

export interface WorkflowDefinition {
  phases: WorkflowPhase[];
  /** Project-specific context injected into every agent's prompt for this workflow. */
  project_specifics?: string | null;
  /** Director (orchestrator) configuration for this workflow. Director runs above
   *  the graph as an invisible engine — phases serve as its playbook. */
  director_config?: DirectorConfig | null;
  /** Named recipes Director can pick from. Optional — if absent, Director
   *  composes ad-hoc dispatches from the skill/gate library directly. */
  playbooks?: Playbook[];
  /** Teams (capability groupings of agents). Director sees them as a separate
   *  axis from the Skills library — "which team handles this kind of problem?".
   *  Optional — if empty, agents are treated individually. */
  teams?: Team[];
}

/** A workflow definition that does not yet know agent ids — resolved per-project on read. */
export const EMPTY_WORKFLOW: WorkflowDefinition = { phases: [] };

/**
 * Normalize a phase to the current shape:
 * - kind="command" → kind="task" with task={type:"shell", config:{command, working_dir, timeout_sec}}
 * - kind missing → kind="agent"
 * Idempotent — passing an already-normalized phase returns it unchanged (legacy fields stripped).
 */
export function normalizePhase(p: WorkflowPhase): WorkflowPhase {
  if (p.kind === "command") {
    const { command, working_dir, timeout_sec, kind, ...rest } = p;
    void kind;
    return {
      ...rest,
      kind: "task",
      task: {
        type: "shell",
        config: {
          command: command ?? "",
          ...(working_dir !== undefined ? { working_dir } : {}),
          ...(timeout_sec !== undefined ? { timeout_sec } : {}),
        },
      },
    };
  }
  if (!p.kind) return { ...p, kind: "agent" };
  return p;
}

export function normalizeWorkflow(wf: WorkflowDefinition): WorkflowDefinition {
  return { ...wf, phases: wf.phases.map(normalizePhase) };
}

export interface ReviewIssue {
  severity: "blocker" | "major" | "minor";
  file?: string;
  line?: number;
  message: string;
}

export interface ReviewVerdict {
  ok: boolean;
  issues: ReviewIssue[];
  summary: string;
}

export interface TestVerdict {
  ok: boolean;
  ran: string[];     // commands executed
  summary: string;
}

export interface RunEvent {
  id: number;
  run_id: string;
  ts: string;
  type: RunEventType;
  payload: string; // JSON-encoded
}
