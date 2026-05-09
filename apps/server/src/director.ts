/**
 * Director-pattern orchestration — top-level agent that decides turn-by-turn
 * which sub-agent to dispatch. Replaces the static phase graph with a single
 * Director phase that drives the entire run.
 *
 * Wiring: see runs.ts — engine treats `kind: "director"` as a terminal phase
 * that handles its own iteration internally.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import type {
  ProjectWithRepos,
  Ticket,
  WorkflowPhase,
  ReviewVerdict,
} from "@ceo/shared";
import { runAgent, specFromAgent } from "./agents.js";
import type { AgentContext } from "./agents.js";
import { loadAgent } from "./store.js";
import { streamClaude } from "./claude.js";
import { extractJsonWithFallback } from "./jsonUtil.js";
import { runTask } from "./tasks/index.js";
import type { TaskContext } from "./tasks/index.js";
import { decomposeTicket } from "./ctoDecompose.js";
import { diffWorktree } from "./git.js";

// ---- Public types -----------------------------------------------------------

export interface DirectorConfig {
  project_brief?: string | null;
  max_iterations?: number;
  budget_usd?: number;
  available_subagents?: string[];
  ci_gate_command?: string;
  ci_gate_timeout_sec?: number;
}

export interface DirectorRunArgs {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  phase: WorkflowPhase;
  worktrees: { repo_name: string; repo_path: string; base_branch: string; path: string }[];
  cwd: string;
  emit: (event: string, payload: Record<string, unknown>) => void;
  registerCancel: (cancel: () => void) => void;
  unregisterCancel: () => void;
}

export interface DirectorResult {
  ok: boolean;
  summary: string;
  iterations: number;
  total_cost_usd: number;
  decomposed?: { subticket_count: number };
}

// ---- Decision schema --------------------------------------------------------

interface DispatchAction { action: "dispatch"; subagent: string; notes: string }
interface CiGateAction { action: "run_ci_gate" }
interface PlaybookAction { action: "run_playbook_phase"; phase_id: string; notes?: string }
interface DecomposeAction { action: "request_decompose"; reason: string }
interface DoneAction { action: "mark_done"; summary: string }
interface GiveUpAction { action: "give_up"; reason: string }
type DirectorAction = DispatchAction | CiGateAction | PlaybookAction | DecomposeAction | DoneAction | GiveUpAction;

interface DirectorDecision {
  rationale: string;
  action: DirectorAction;
}

interface SubagentOutcome {
  kind: "subagent";
  subagent: string;
  ok: boolean | null;
  summary: string;
  issues: { severity?: string; message?: string }[];
  commits_added: number;
  cost_usd: number;
}
interface CiGateOutcome {
  kind: "ci_gate";
  ok: boolean;
  summary: string;
  details_tail: string;
}
interface TerminalOutcome {
  kind: "terminal";
  status: "succeeded" | "failed" | "decomposed";
  reason: string;
}
type Outcome = SubagentOutcome | CiGateOutcome | TerminalOutcome;

interface TurnRecord {
  iteration: number;
  decision: DirectorDecision;
  outcome: Outcome;
}

// ---- Constants --------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_BUDGET_USD = 8;
const DIRECTOR_MODEL = "claude-sonnet-4-6";
const SUBAGENT_BLACKLIST = new Set(["CTO", "Memory Curator", "Director"]);

// ---- Main entry -------------------------------------------------------------

export async function runDirectorPhase(args: DirectorRunArgs): Promise<DirectorResult> {
  const cfg = (args.phase.director ?? {}) as DirectorConfig;
  const maxIter = cfg.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const budget = cfg.budget_usd ?? DEFAULT_BUDGET_USD;

  const history: TurnRecord[] = [];
  let totalCost = 0;
  let iter = 0;

  const subagents = resolveAvailableSubagents(args.project, cfg);

  args.emit("director_start", {
    max_iterations: maxIter,
    budget_usd: budget,
    available_subagents: subagents,
    project_brief: cfg.project_brief ?? null,
  });

  while (iter < maxIter) {
    iter++;

    if (totalCost >= budget) {
      args.emit("director_end", { reason: "budget_exhausted", total_cost_usd: totalCost, iterations: iter });
      return { ok: false, summary: `Budget $${budget} exhausted at $${totalCost.toFixed(2)}`, iterations: iter, total_cost_usd: totalCost };
    }

    let decision: DirectorDecision;
    let decisionCost: number;
    try {
      const r = await callDirector(args, history, { totalCost, budget, iter, maxIter, subagents });
      decision = r.decision;
      decisionCost = r.cost;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      args.emit("system", { msg: `Director call failed: ${msg}` });
      return { ok: false, summary: `Director crashed: ${msg}`, iterations: iter, total_cost_usd: totalCost };
    }
    totalCost += decisionCost;

    args.emit("director_decision", {
      iteration: iter,
      rationale: decision.rationale,
      action: decision.action,
      cost_usd: decisionCost,
      total_cost_usd: totalCost,
    });

    const action = decision.action;

    if (action.action === "mark_done") {
      history.push({ iteration: iter, decision, outcome: { kind: "terminal", status: "succeeded", reason: action.summary } });
      args.emit("director_end", { reason: "mark_done", iterations: iter, total_cost_usd: totalCost });
      return { ok: true, summary: action.summary, iterations: iter, total_cost_usd: totalCost };
    }
    if (action.action === "give_up") {
      history.push({ iteration: iter, decision, outcome: { kind: "terminal", status: "failed", reason: action.reason } });
      args.emit("director_end", { reason: "give_up", iterations: iter, total_cost_usd: totalCost });
      return { ok: false, summary: action.reason, iterations: iter, total_cost_usd: totalCost };
    }
    if (action.action === "request_decompose") {
      try {
        const result = await decomposeTicket(args.project, args.ticket);
        args.emit("director_end", {
          reason: "decompose_requested",
          decomposed: result.decomposed,
          subticket_count: result.created.length,
          iterations: iter,
          total_cost_usd: totalCost,
        });
        return {
          ok: result.decomposed,
          summary: result.decomposed
            ? `Decomposed into ${result.created.length} subticket(s): ${result.rationale}`
            : `CTO declined to decompose: ${result.rationale}`,
          iterations: iter,
          total_cost_usd: totalCost,
          decomposed: result.decomposed ? { subticket_count: result.created.length } : undefined,
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        args.emit("system", { msg: `request_decompose failed: ${msg}` });
        history.push({ iteration: iter, decision, outcome: { kind: "terminal", status: "failed", reason: `decompose failed: ${msg}` } });
        continue;
      }
    }

    if (action.action === "dispatch") {
      const outcome = await dispatchSubagent(args, action.subagent, action.notes);
      totalCost += outcome.cost_usd;
      history.push({ iteration: iter, decision, outcome });
      continue;
    }

    if (action.action === "run_ci_gate") {
      const outcome = await runCiGate(args, cfg);
      history.push({ iteration: iter, decision, outcome });
      continue;
    }

    if (action.action === "run_playbook_phase") {
      const outcome = await runPlaybookPhase(args, cfg, action.phase_id, action.notes ?? "");
      if (outcome.kind === "subagent") totalCost += outcome.cost_usd;
      history.push({ iteration: iter, decision, outcome });
      continue;
    }

    args.emit("system", { msg: `Director returned unknown action: ${JSON.stringify(action)}` });
    return { ok: false, summary: `Unknown action`, iterations: iter, total_cost_usd: totalCost };
  }

  args.emit("director_end", { reason: "max_iterations", iterations: iter, total_cost_usd: totalCost });
  return { ok: false, summary: `Max iterations (${maxIter}) reached`, iterations: iter, total_cost_usd: totalCost };
}

// ---- Director call (single Claude turn) -------------------------------------

interface DirectorCallReturn {
  decision: DirectorDecision;
  cost: number;
}

async function callDirector(
  args: DirectorRunArgs,
  history: TurnRecord[],
  budget: { totalCost: number; budget: number; iter: number; maxIter: number; subagents: string[] },
): Promise<DirectorCallReturn> {
  const cfg = (args.phase.director ?? {}) as DirectorConfig;
  const systemPrompt = buildDirectorSystemPrompt(budget.subagents, cfg, args.project);
  const prompt = buildDirectorTurnPrompt(args, history, budget);

  let stdoutBuf = "";
  let cost = 0;

  const { promise, cancel } = streamClaude(
    {
      prompt,
      systemPrompt,
      cwd: args.cwd,
      model: DIRECTOR_MODEL,
    },
    {
      onLine: (line) => {
        stdoutBuf += line + "\n";
        try {
          const ev = JSON.parse(line);
          if (ev?.type === "result" && typeof ev.total_cost_usd === "number") {
            cost = ev.total_cost_usd;
          }
        } catch {
          /* not JSON */
        }
      },
      onStderr: () => {},
    },
  );
  args.registerCancel(cancel);
  await promise;
  args.unregisterCancel();

  const parsed = extractJsonWithFallback<DirectorDecision>(stdoutBuf);
  if (!parsed || typeof parsed !== "object" || !("action" in parsed)) {
    return {
      decision: {
        rationale: "Could not parse Director output as JSON",
        action: { action: "give_up", reason: "Director returned unparseable output" },
      },
      cost,
    };
  }
  const a = (parsed as DirectorDecision).action as DirectorAction | undefined;
  if (!a || typeof a !== "object" || typeof a.action !== "string") {
    return {
      decision: {
        rationale: (parsed as DirectorDecision).rationale ?? "Invalid action shape",
        action: { action: "give_up", reason: "Director returned invalid action object" },
      },
      cost,
    };
  }
  return { decision: parsed as DirectorDecision, cost };
}

// ---- Director system + turn prompts ----------------------------------------

function buildDirectorSystemPrompt(subagents: string[], cfg: DirectorConfig, project: ProjectWithRepos): string {
  const subagentList = subagents.length === 0
    ? "(none configured — request_decompose or give_up only)"
    : subagents.map((s) => `  - ${s}`).join("\n");

  const playbook = renderPlaybook(project);

  return `You are the Director — the lead orchestrator on this project. You are a tech lead who delegates work; you DO NOT write code or modify files yourself.

Your only output is a single JSON object describing the next action. The runtime executes it and reports back. Be terse. Reflect, decide, move on.

## Project: ${project.name}

${project.description || "(no description)"}

${cfg.project_brief ? `## Project brief\n${cfg.project_brief}\n` : ""}

## Playbook (the team's reference pipeline for this project)

${playbook}

The playbook is a STARTING POINT — the standard pipeline this team uses for tickets like this. Follow it when it fits, deviate when the ticket is small (skip steps), retry early phases when reviewer/CI bounces, parallelize when independent. You are NOT obligated to walk every node; you ARE expected to use it as a smart default and to know what each named phase means.

## Available actions

\`\`\`
{ "action": "dispatch", "subagent": "<name>", "notes": "<concrete instructions>" }
{ "action": "run_playbook_phase", "phase_id": "<id from playbook>", "notes": "<optional override/addendum>" }
{ "action": "run_ci_gate" }
{ "action": "request_decompose", "reason": "<why split>" }
{ "action": "mark_done", "summary": "<what was delivered>" }
{ "action": "give_up", "reason": "<concrete blocker>" }
\`\`\`

\`run_playbook_phase\` runs a phase from the playbook with its configured agent and notes — use it when the playbook node already captures what you want (e.g. \`ci_gate\` for the canonical CI command, \`reviewer\` for the standard review prompt). Use \`dispatch\` when you want a custom dispatch (different notes, different scope) or for ad-hoc work outside the playbook. \`run_ci_gate\` is shorthand for the playbook's \`ci_gate\` phase if it exists.

### Available sub-agents for dispatch:
${subagentList}

## Strategy rules

1. Use the playbook. For any non-trivial ticket the playbook is the right opening sequence — start with \`tech_lead\` or \`architect\` if those exist, otherwise dispatch a coder directly.
2. Start cheap. Junior (Haiku) does bulk work. Reach for Senior (Opus) only after Junior bounces twice or Reviewer surfaces architecture issues.
3. Reflect. Each turn, look at the last 1-2 outcomes. Do not repeat what just failed identically.
4. Hard limits: do not dispatch the same sub-agent more than 4 times in one run. After 3 cycles without progress, request_decompose or give_up.
5. Always run ci_gate (or run_ci_gate) before mark_done. If ci_gate fails twice for the same root cause, give_up — do not loop forever.
6. request_decompose when the ticket spans unrelated concerns (infra + code + docs as independent threads). CTO will create subtickets and end this run cleanly.
7. Notes are CONCRETE: "Add /version endpoint to api/ following HealthController pattern, smoke test required" — NOT "do the ticket".

## Output format

Reply with ONE JSON object on the LAST line of your response. Optionally include short reasoning above; the runtime only reads the last JSON.

\`\`\`json
{
  "rationale": "<1-2 sentences>",
  "action": { ... one of the actions above ... }
}
\`\`\``;
}

function renderPlaybook(project: ProjectWithRepos): string {
  const phases = (project.workflow.phases ?? []).filter((p) => p.kind !== "director");
  if (phases.length === 0) return "(no playbook phases — workflow is Director-only; you must drive entirely from the sub-agent registry)";
  const agentById = new Map(project.agents.map((a) => [a.id, a]));
  const lines: string[] = [];
  for (const p of phases) {
    const kind = p.kind ?? "agent";
    let head = `- **${p.id}** [${kind}]`;
    if (kind === "agent" && p.agent_id) {
      const a = agentById.get(p.agent_id);
      head += a ? ` → agent "${a.name}" (${a.role}${a.model ? `, ${a.model}` : ""})` : ` → agent ${p.agent_id} (missing)`;
    } else if (kind === "task" && p.task) {
      head += ` → task ${p.task.type}`;
      if (p.task.type === "shell") {
        const cmd = String((p.task.config as Record<string, unknown>)?.command ?? "");
        const oneliner = cmd.split("\n")[0]?.slice(0, 80) ?? "";
        if (oneliner) head += ` (\`${oneliner}${cmd.includes("\n") ? " …" : ""}\`)`;
      }
    } else if (kind === "approval") {
      head += " → human gate";
    }
    lines.push(head);
    if (p.notes) lines.push(`    notes: ${p.notes.slice(0, 200)}${p.notes.length > 200 ? "…" : ""}`);
    const flow: string[] = [];
    if (p.next) flow.push(`next → ${p.next}`);
    if (p.retry_target) flow.push(`on-fail → ${p.retry_target} (max ${p.max_attempts ?? 2})`);
    if (p.routes) flow.push(`routes: ${Object.entries(p.routes).map(([k, v]) => `${k}→${v}`).join(", ")}`);
    if (flow.length) lines.push(`    flow: ${flow.join("; ")}`);
  }
  return lines.join("\n");
}

function buildDirectorTurnPrompt(
  args: DirectorRunArgs,
  history: TurnRecord[],
  budget: { totalCost: number; budget: number; iter: number; maxIter: number; subagents: string[] },
): string {
  const parts: string[] = [
    `# Ticket: ${args.ticket.ticket_key ?? args.ticket.id} — ${args.ticket.title}`,
    "",
    args.ticket.body || "(no body)",
  ];
  if (args.ticket.triage_notes) {
    parts.push("", "## Triage notes", args.ticket.triage_notes);
  }
  parts.push(
    "",
    "## Repos in this run",
    ...args.worktrees.map((w) => `- ${w.repo_name} (${w.path})`),
    "",
    "## Budget",
    `- iteration ${budget.iter}/${budget.maxIter}`,
    `- spent $${budget.totalCost.toFixed(2)} / $${budget.budget.toFixed(2)}`,
  );

  if (history.length === 0) {
    parts.push("", "## History", "(none — this is your first decision)");
  } else {
    parts.push("", `## History (last ${Math.min(history.length, 10)} of ${history.length})`);
    for (const t of history.slice(-10)) {
      parts.push("");
      parts.push(`### Turn ${t.iteration}`);
      parts.push(`Decision: ${formatDecision(t.decision)}`);
      parts.push(`Outcome: ${formatOutcome(t.outcome)}`);
    }
  }

  parts.push("", "Decide the next action. Reply with JSON ONLY on the last line.");
  return parts.join("\n");
}

function formatDecision(d: DirectorDecision): string {
  const a = d.action;
  let act: string = a.action;
  if (a.action === "dispatch") act = `dispatch ${a.subagent}: ${a.notes.slice(0, 100)}`;
  if (a.action === "run_playbook_phase") act = `run_playbook_phase ${a.phase_id}${a.notes ? `: ${a.notes.slice(0, 80)}` : ""}`;
  if (a.action === "mark_done") act = `mark_done: ${a.summary.slice(0, 100)}`;
  if (a.action === "give_up") act = `give_up: ${a.reason.slice(0, 100)}`;
  if (a.action === "request_decompose") act = `request_decompose: ${a.reason.slice(0, 100)}`;
  return `${act}  [${d.rationale.slice(0, 100)}]`;
}

function formatOutcome(o: Outcome): string {
  if (o.kind === "subagent") {
    const issues = o.issues.length > 0 ? ` issues: ${o.issues.slice(0, 3).map((i) => i.message ?? "").join(" / ")}` : "";
    return `[${o.subagent}] ok=${o.ok} commits=+${o.commits_added} cost=$${o.cost_usd.toFixed(2)}${issues}\n  summary: ${o.summary.slice(0, 200)}`;
  }
  if (o.kind === "ci_gate") {
    return `ci_gate ok=${o.ok}\n  summary: ${o.summary.slice(0, 150)}\n  tail: ${o.details_tail.slice(0, 300)}`;
  }
  return `terminal ${o.status}: ${o.reason}`;
}

// ---- Sub-agent dispatch -----------------------------------------------------

function resolveAvailableSubagents(project: ProjectWithRepos, cfg: DirectorConfig): string[] {
  if (cfg.available_subagents && cfg.available_subagents.length > 0) {
    return cfg.available_subagents.filter((n) => project.agents.some((a) => a.name === n));
  }
  return project.agents
    .filter((a) => !SUBAGENT_BLACKLIST.has(a.name))
    .map((a) => a.name);
}

async function dispatchSubagent(
  args: DirectorRunArgs,
  subagentName: string,
  notes: string,
): Promise<SubagentOutcome> {
  const projectAgent = args.project.agents.find((a) => a.name === subagentName);
  if (!projectAgent) {
    args.emit("director_dispatch", { subagent: subagentName, error: "unknown subagent" });
    return {
      kind: "subagent",
      subagent: subagentName,
      ok: false,
      summary: `Subagent "${subagentName}" not in project`,
      issues: [{ severity: "blocker", message: "unknown subagent" }],
      commits_added: 0,
      cost_usd: 0,
    };
  }
  const dbAgent = loadAgent(projectAgent.id);
  if (!dbAgent) {
    return {
      kind: "subagent",
      subagent: subagentName,
      ok: false,
      summary: `Subagent "${subagentName}" not found in DB`,
      issues: [{ severity: "blocker", message: "agent not in DB" }],
      commits_added: 0,
      cost_usd: 0,
    };
  }

  args.emit("director_dispatch", {
    subagent: subagentName,
    role: dbAgent.role,
    model: dbAgent.model,
    notes: notes.slice(0, 300),
  });

  const commitsBefore = await countWorktreeCommits(args.worktrees);
  const diffsBefore = await collectWorktreeDiffs(args.worktrees);

  const spec = specFromAgent(dbAgent);
  const ctx: AgentContext = {
    project: args.project,
    ticket: args.ticket,
    worktrees: args.worktrees.map((w) => ({ repo_name: w.repo_name, path: w.path })),
    cwd: args.cwd,
    diffs: diffsBefore,
    reviewerFeedback: undefined,
    projectSpecifics: args.project.workflow.project_specifics ?? null,
    phaseNotes: notes,
    pipelineContext: `You are working under a Director. After your turn the Director will read your verdict and decide what to do next (dispatch you again, escalate, mark done, etc.). Make focused, scoped changes per the notes above.`,
    recentRuns: null,
  };

  let cost = 0;
  const handlers = {
    onLine: (line: string) => {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === "result" && typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
      } catch {
        /* not JSON */
      }
      // Forward stream events so RunView can show sub-agent activity.
      try {
        args.emit("claude_stream", JSON.parse(line));
      } catch {
        /* skip non-JSON lines */
      }
    },
    onStderr: (chunk: string) => args.emit("stderr", { chunk }),
  };

  let r;
  try {
    r = await runAgent(spec, ctx, handlers, args.registerCancel);
    args.unregisterCancel();
  } catch (e: unknown) {
    args.unregisterCancel();
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "subagent",
      subagent: subagentName,
      ok: false,
      summary: `Subagent crashed: ${msg}`,
      issues: [{ severity: "blocker", message: msg }],
      commits_added: 0,
      cost_usd: cost,
    };
  }

  const commitsAfter = await countWorktreeCommits(args.worktrees);
  const commitsAdded = commitsAfter - commitsBefore;

  const verdict = r.verdict as ReviewVerdict | null;
  const ok = verdict ? (verdict as { ok?: boolean }).ok ?? null : null;
  const summary = verdict ? (verdict as { summary?: string }).summary ?? "" : r.finalText.slice(0, 200);
  const issues = verdict ? ((verdict as { issues?: { severity?: string; message?: string }[] }).issues ?? []) : [];

  args.emit("director_subagent_done", {
    subagent: subagentName,
    ok,
    commits_added: commitsAdded,
    cost_usd: cost,
    summary: summary.slice(0, 200),
  });

  return {
    kind: "subagent",
    subagent: subagentName,
    ok,
    summary,
    issues,
    commits_added: commitsAdded,
    cost_usd: cost,
  };
}

// ---- Playbook phase dispatch ------------------------------------------------

async function runPlaybookPhase(
  args: DirectorRunArgs,
  cfg: DirectorConfig,
  phaseId: string,
  extraNotes: string,
): Promise<Outcome> {
  const phase = args.project.workflow.phases.find((p) => p.id === phaseId);
  if (!phase) {
    args.emit("director_dispatch", { subagent: `playbook:${phaseId}`, error: "phase not in playbook" });
    return {
      kind: "subagent",
      subagent: `playbook:${phaseId}`,
      ok: false,
      summary: `Playbook phase "${phaseId}" not found`,
      issues: [{ severity: "blocker", message: "phase not in workflow" }],
      commits_added: 0,
      cost_usd: 0,
    };
  }
  const kind = phase.kind ?? "agent";
  if (kind === "agent" && phase.agent_id) {
    const projectAgent = args.project.agents.find((a) => a.id === phase.agent_id);
    if (!projectAgent) {
      return {
        kind: "subagent",
        subagent: `playbook:${phaseId}`,
        ok: false,
        summary: `Playbook phase "${phaseId}" references missing agent`,
        issues: [{ severity: "blocker", message: "agent missing" }],
        commits_added: 0,
        cost_usd: 0,
      };
    }
    const combinedNotes = [phase.notes, extraNotes].filter(Boolean).join("\n\n");
    return dispatchSubagent(args, projectAgent.name, combinedNotes || `Run playbook phase "${phaseId}"`);
  }
  if (kind === "task" && phase.task?.type === "shell") {
    // Treat shell tasks (ci_gate, lint, etc.) as ci-gate-style outcomes.
    const cfg2: DirectorConfig = {
      ...cfg,
      ci_gate_command: String((phase.task.config as Record<string, unknown>)?.command ?? ""),
      ci_gate_timeout_sec: typeof (phase.task.config as Record<string, unknown>)?.timeout_sec === "number"
        ? Number((phase.task.config as Record<string, unknown>).timeout_sec)
        : cfg.ci_gate_timeout_sec,
    };
    return runCiGate(args, cfg2);
  }
  return {
    kind: "subagent",
    subagent: `playbook:${phaseId}`,
    ok: false,
    summary: `Playbook phase "${phaseId}" has unsupported kind "${kind}" (only agent/shell-task supported)`,
    issues: [{ severity: "blocker", message: `unsupported kind ${kind}` }],
    commits_added: 0,
    cost_usd: 0,
  };
}

// ---- ci_gate dispatch -------------------------------------------------------

async function runCiGate(args: DirectorRunArgs, cfg: DirectorConfig): Promise<CiGateOutcome> {
  let command = cfg.ci_gate_command;
  let timeoutSec = cfg.ci_gate_timeout_sec ?? 1800;
  if (!command) {
    const ciPhase = args.project.workflow.phases.find(
      (p) => p.id === "ci_gate" && p.kind === "task" && p.task?.type === "shell",
    );
    if (ciPhase && ciPhase.task) {
      const c = (ciPhase.task.config as Record<string, unknown>).command;
      if (typeof c === "string") command = c;
      const t = (ciPhase.task.config as Record<string, unknown>).timeout_sec;
      if (typeof t === "number") timeoutSec = t;
    }
  }
  if (!command) {
    return {
      kind: "ci_gate",
      ok: false,
      summary: "no ci_gate_command configured on director, and no ci_gate phase in workflow",
      details_tail: "",
    };
  }

  args.emit("director_dispatch", {
    subagent: "ci_gate",
    command_preview: command.slice(0, 200),
    timeout_sec: timeoutSec,
  });

  const taskCtx: TaskContext = {
    runId: args.runId,
    runDir: args.cwd,
    project: args.project,
    ticket: args.ticket,
    phase: args.phase,
    lastVerdict: null,
    lastWasFailure: false,
    emit: (event, payload) => args.emit(event, payload),
    registerCancel: args.registerCancel,
    unregisterCancel: args.unregisterCancel,
  };

  const verdict = await runTask("shell", { command, timeout_sec: timeoutSec }, taskCtx);
  const tail = String((verdict as { details?: string }).details ?? "").slice(-2000);

  args.emit("director_subagent_done", {
    subagent: "ci_gate",
    ok: verdict.ok,
    summary: String(verdict.summary ?? "").slice(0, 200),
  });

  return {
    kind: "ci_gate",
    ok: !!verdict.ok,
    summary: String(verdict.summary ?? "").slice(0, 400),
    details_tail: tail,
  };
}

// ---- Worktree helpers -------------------------------------------------------

async function countWorktreeCommits(
  worktrees: { repo_name: string; path: string; base_branch: string }[],
): Promise<number> {
  let total = 0;
  for (const w of worktrees) {
    if (!fs.existsSync(w.path)) continue;
    try {
      const r = await runGit(["rev-list", "--count", `${w.base_branch}..HEAD`], w.path);
      const n = parseInt(r.stdout.trim(), 10);
      if (!Number.isNaN(n)) total += n;
    } catch {
      /* ignore */
    }
  }
  return total;
}

async function collectWorktreeDiffs(
  worktrees: { repo_name: string; path: string; base_branch: string }[],
): Promise<string> {
  const parts: string[] = [];
  for (const w of worktrees) {
    if (!fs.existsSync(w.path)) continue;
    try {
      const d = await diffWorktree(w.path, w.base_branch);
      if (d.trim()) parts.push(`# ${w.repo_name}\n${d}`);
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n\n");
}

function runGit(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn("git", argv, { cwd });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => { stdout += c.toString(); });
    p.stderr.on("data", (c) => { stderr += c.toString(); });
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    p.on("error", () => resolve({ stdout: "", stderr: "", code: -1 }));
  });
}
