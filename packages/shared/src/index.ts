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
  /** When set, scheduler auto-pauses (stops starting new runs) at this ISO
   *  timestamp. In-flight runs drain naturally. Cleared on manual mode change
   *  or when the deadline fires. */
  pause_after: string | null;
}

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

/** User-supplied quality verdict on a completed run. Drives the feedback loop:
 *  Memory Curator surfaces "bad" / "broken_in_prod" as anti-patterns in the
 *  episodic memory passed to future Director runs. */
export type RunUserVerdict = "good" | "bad" | "broken_in_prod";

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
  /** Optional user-supplied verdict on the completed run. Null = not rated. */
  user_verdict: RunUserVerdict | null;
  user_verdict_at: string | null;
  user_verdict_note: string | null;
  created_at: string;
}

export interface SetRunVerdictInput {
  /** Pass null to clear the verdict. */
  verdict: RunUserVerdict | null;
  note?: string | null;
}

/** One stored connection-test result per (scope, connector group). Updated
 *  every time the user clicks "Test connection". UI uses this to show a
 *  status badge + last-tested age without re-hitting the connector API. */
export interface ConnectorHealthRow {
  /** "global" for admin scope, otherwise project_id. */
  scope: string;
  /** "github" | "jira" | "ssh" */
  group_name: string;
  last_tested_at: string;
  ok: boolean;
  /** Human-readable error message when ok=false; null on success. */
  error: string | null;
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
  | "director_paused"   // director-phase: pausing for budget or human review
  | "director_context_fetched" // director-phase: fetched data from connector
  | "director_human_review_resolved" // director-phase: user answered human-review pause
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
  /** When set, this agent is sourced from a global Skill template (library).
   *  The server overlays the latest template fields on read so edits made in
   *  Admin propagate to every project sharing the template. UI locks the
   *  agent's editable fields when this is set; the link points the user back
   *  to the admin template editor. Null/undefined = fully local agent. */
  template_key?: string | null;
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
  if (phase.kind === "task") {
    // git_push isn't validation — it's the closing/deploy step that makes
    // the work delivered. Group with approval gates in the prompt.
    if (phase.task?.type === "git_push") return "closing";
    return "validation";
  }
  if (phase.kind === "command") return "validation";
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

/** A pre-defined agent template the user can instantiate into a project.
 *  Conceptually a "Skill template" in the library — admin defines the
 *  specialist (prompt + model + tools) plus default notes/category that get
 *  copied into the phase on import. Project-side agents that came from a
 *  template carry `template_key` and become read-only in the project — the
 *  UI redirects edits back to the admin library so changes propagate to all
 *  projects sharing the template. */
export interface AgentTemplate {
  key: string;                  // stable identifier
  name: string;
  role: AgentRole;
  category: string;
  description: string;          // 1-line, shown in template picker
  system_prompt: string;
  model: string | null;
  allowed_tools: string[] | null;
  /** Default notes appended to the prompt every time this skill runs in
   *  a project (still overrideable per phase). Optional. */
  default_notes?: string | null;
  /** Default capability bucket for the auto-created phase on import. */
  default_skill_category?: SkillCategory;
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

/** @deprecated Named Playbooks were dropped in favor of Director's ad-hoc
 *  dispatch chain (which hit similar costs in practice and didn't add UI
 *  complexity). The types stay for back-compat with existing project data
 *  and templates that may still carry playbooks[]; the engine no longer
 *  renders or invokes them. Safe to remove from new projects.
 *
 *  Step within a named Playbook — a reference to a skill/gate (phase) the
 *  Playbook walks in order. */
export interface PlaybookStep {
  /** Phase id from WorkflowDefinition.phases. */
  phase_id: string;
  /** Optional addendum appended to the phase's notes for this Playbook only. */
  notes_override?: string | null;
  /** If true, Director may skip this step when its judgement says it's not
   *  needed (e.g. an extra reviewer pass on a trivial change). Default false. */
  optional?: boolean;
}

/** @deprecated See PlaybookStep. */
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
  /** Phase IDs (typically connector tasks: jira/github/ssh/telegram) to fire
   *  after Director marks the run done. Run sequentially in array order; a
   *  hook failure is logged but doesn't fail the run. */
  on_success?: string[];
  /** Phase IDs to fire after Director gives up / hits max iterations / cancels.
   *  Same semantics as on_success — sequential, non-failing. */
  on_failure?: string[];
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

// ----- Scheduled Jobs --------------------------------------------------------

/**
 * Job = trigger (when) + action (what). The two are orthogonal:
 *   - Cron + create_ticket   → "every Monday 9am create a lint ticket"
 *   - Cron + telegram_digest → "every morning push stats to Telegram"
 *   - Watch + create_ticket  → "when a new PR is review-requested → ticket"
 *
 * Connector secrets (github_token / jira_* / ssh_*) live on the project; both
 * triggers and actions reference them via project_id and pull from
 * project_secrets — neither owns credentials.
 */

// ---- Triggers ---------------------------------------------------------------

/** Cron-based: fires on a fixed schedule, action runs unconditionally. */
export interface CronTrigger {
  type: "cron";
  /** 5-field cron expression OR "@once:<ISO timestamp>" for one-shot. */
  schedule: string;
}

/** Polls an external source via the project's connector secrets, dedupes by
 *  stable IDs persisted in the job state, and fires the action ONCE per new
 *  item observed. First poll establishes a baseline (no fire). */
export interface WatchTrigger {
  type: "watch";
  /** Which connector to poll. Credentials come from project secrets. */
  source: "github" | "jira";
  /** Source-specific query.
   *   github: GitHub search syntax, e.g. "is:pr review-requested:@me"
   *   jira:   JQL, e.g. "assignee = currentUser() AND status = 'To Do'" */
  query: string;
  /** Cron expression for poll interval (e.g. "* /5 * * * *" → every 5 min). */
  poll_schedule: string;
}

export type ScheduledJobTrigger = CronTrigger | WatchTrigger;

// ---- Actions ----------------------------------------------------------------

/** Create a ticket in the job's project. When auto_start, immediately starts a
 *  Director run. Templates support {watch_*} placeholders for watch triggers. */
export interface CreateTicketAction {
  type: "create_ticket";
  title: string;
  body: string;
  priority?: Priority;
  auto_start?: boolean;
}

/** Push deterministic stats summary to a Telegram chat. */
export interface TelegramDigestAction {
  type: "telegram_digest";
  chat_id?: number;
  lookback_hours?: number;
}

/** Flip the backlog scheduler. Pair two of these (running/paused) for a
 *  maintenance window. */
export interface SchedulerModeAction {
  type: "scheduler_mode";
  mode: SchedulerMode;
}

/** Run a one-shot Reviewer agent on a GitHub PR's diff and submit the result
 *  as a proper GitHub review (with inline per-file/line comments where the
 *  agent identifies issues). No ticket, no worktree, no Director — direct
 *  path from "watch found a PR" to "PR has a structured review".
 *
 *  Works at two scopes:
 *    - **Project-scoped** (job.project_id set): uses the project's Reviewer
 *      agent + project's github_token from connector secrets.
 *    - **Global** (job.project_id null): uses an admin Skill template
 *      (default key "reviewer") + GITHUB_TOKEN env var. Token sees whatever
 *      PRs it has access to.
 *
 *  Resolves PR coordinates from watch placeholders ({watch_repo}, {watch_id}).
 */
export interface ReviewPrAction {
  type: "review_pr";
  /** Project-scope: agent name (must exist in project.agents). Falls back to
   *  the first reviewer-role agent if blank. */
  agent_name?: string;
  /** Global-scope: admin Skill template key (default "reviewer"). Ignored when
   *  the job has a project_id. */
  agent_template_key?: string;
  /** When true (default), post the review back to the PR. Set false for dry
   *  runs (review is generated and logged, nothing posted). */
  post_comment?: boolean;
  /** Review depth.
   *    "comprehensive" — full review with style + nits + suggestions.
   *    "critical_only" — only functional bugs, typos, security/perf concerns.
   *  Defaults to "comprehensive". */
  focus_mode?: "comprehensive" | "critical_only";
  /** Override target — only useful for static cron jobs that target one PR.
   *  Defaults to "{watch_repo}" / "{watch_id}" from the trigger item. */
  repo_template?: string;
  pr_number_template?: string;
}

/** Send a one-off Telegram message. Sibling to telegram_digest — that one
 *  reports stats from local DB; this one is generic templated text. */
export interface TelegramMessageAction {
  type: "telegram_message";
  chat_id?: number;
  /** Message body. Supports {watch_*} placeholders from watch triggers. */
  text: string;
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML" | "";
}

/** Generic HTTP webhook — POST/PUT/PATCH any URL with templated body.
 *  Replaces dedicated Slack / Discord / n8n / Make / Zapier connectors —
 *  one action covers all "send X somewhere" cases. */
export interface WebhookAction {
  type: "webhook";
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  /** Free-form headers (Authorization, X-Custom, etc.). */
  headers?: Record<string, string>;
  /** Request body — typically JSON. Supports {watch_*} placeholders. */
  body_template: string;
  /** Defaults to application/json. */
  content_type?: string;
}

/** Perform a single GitHub operation against a target repo. Subsumes the
 *  scheduled-job analog of the workflow connector phase (issue_comment etc.)
 *  plus three new ops (assign, request_reviewers, dispatch_workflow). */
export type GithubOp =
  | { op: "issue_comment"; repo: string; issue_number: string; body: string }
  | { op: "set_labels"; repo: string; issue_number: string; labels: string[] }
  | { op: "close_issue"; repo: string; issue_number: string }
  | { op: "assign"; repo: string; issue_number: string; assignees: string[] }
  | { op: "request_reviewers"; repo: string; pr_number: string; reviewers: string[]; team_reviewers?: string[] }
  | { op: "dispatch_workflow"; repo: string; workflow_id: string; ref?: string; inputs?: Record<string, string> };

export interface GithubOpAction {
  type: "github_op";
  /** Operation discriminator + its config. All string fields support
   *  {watch_*} placeholders so cron-triggered jobs can target a fixed item
   *  while watch-triggered jobs target the trigger's item. */
  github: GithubOp;
}

export type ScheduledJobAction =
  | CreateTicketAction
  | TelegramDigestAction
  | TelegramMessageAction
  | SchedulerModeAction
  | ReviewPrAction
  | WebhookAction
  | GithubOpAction;

export type ScheduledJobActionType = ScheduledJobAction["type"];
export type ScheduledJobTriggerType = ScheduledJobTrigger["type"];

// ---- Top-level shape --------------------------------------------------------

// ---- review_pr structured output -------------------------------------------

export const REVIEW_SEVERITIES = ["blocker", "major", "minor"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const WATCH_SOURCES = ["github", "jira"] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];

/** One inline review comment anchored on a specific file:line. Posted to
 *  GitHub via the Pull Request Review API as one item in `comments[]`. */
export interface InlineReviewComment {
  path: string;
  line: number;
  /** "RIGHT" for added/modified lines (default), "LEFT" for deletions. */
  side?: "LEFT" | "RIGHT";
  severity: ReviewSeverity;
  body: string;
}

/** Structured Reviewer output. The model is asked to return ONLY this shape,
 *  parsed from its stream-json transcript and persisted to job_runs.details_json
 *  for inspection in the activity feed. */
export interface ReviewerOutput {
  comments: InlineReviewComment[];
}

/** Wrapped details payload stored on job_runs.details_json for review_pr runs.
 *  `mode` distinguishes a dry run / real-post / no-comments fast path so the
 *  UI can label them appropriately. */
export interface ReviewPrRunDetails {
  mode: "dry_run" | "posted" | "no_comments";
  repo: string;
  pr: number;
  review: ReviewerOutput;
}

/** Persistent log entry from job_runs table. One row per action invocation
 *  (or trigger error). The list endpoint omits `details` to keep payloads
 *  lean — set `has_details=true` and the UI lazy-loads via GET /job-runs/:id. */
export interface JobRun {
  id: number;
  job_id: string;
  job_name: string;
  action_type: ScheduledJobActionType | string;
  project_id: string | null;
  fired_at: string;
  ok: boolean;
  /** Surfaces in the bell when true; ignored when false (quiet successes). */
  notable: boolean;
  summary: string;
  url: string | null;
  /** True when the row has a details_json blob (e.g. ReviewerOutput).
   *  Set by the list endpoint; full content fetched on expand via GET /:id. */
  has_details?: boolean;
  /** Full details payload — present only on single-row fetch (GET /:id) or
   *  legacy clients. */
  details?: unknown;
}

/** Compact audit/notification entry surfaced from a job's recent runs. */
export interface ScheduledJobResult {
  at: string;
  summary: string;
  /** External URL if the action produced one (review on GitHub, ticket, etc). */
  url?: string;
  /** Set on fan-out runs — which project this entry came from. */
  project_id?: string;
}

export interface ScheduledJob {
  id: string;
  name: string;
  /** Single-scope: project this job runs in (null = default scope using admin secrets).
   *  Ignored when `fan_out_project_ids` is set. */
  project_id: string | null;
  /** Fan-out: when non-empty, the job runs ONCE per project in this list,
   *  each with that project's secrets / state / result trail. State is
   *  partitioned per project so a new commit on PR-X in project A won't
   *  shadow a different PR in project B. */
  fan_out_project_ids?: string[];
  trigger: ScheduledJobTrigger;
  action: ScheduledJobAction;
  /** Computed at create/update/fire. Null = disabled / one-shot fired. */
  next_run_at: string | null;
  last_run_at: string | null;
  enabled: boolean;
  /** Last N action results across all (sub-)executions, most recent first.
   *  Each entry may carry `project_id` for fan-out runs. */
  recent_results?: ScheduledJobResult[];
  created_at: string;
  updated_at: string;
}

export interface CreateScheduledJobInput {
  name: string;
  project_id?: string | null;
  fan_out_project_ids?: string[];
  trigger: ScheduledJobTrigger;
  action: ScheduledJobAction;
  enabled?: boolean;
}

export interface UpdateScheduledJobInput {
  name?: string;
  project_id?: string | null;
  fan_out_project_ids?: string[];
  trigger?: ScheduledJobTrigger;
  action?: ScheduledJobAction;
  enabled?: boolean;
}
