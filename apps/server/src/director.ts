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
  DirectorConfig as SharedDirectorConfig,
  SkillCategory,
} from "@ceo/shared";
import { deriveSkillCategory, SKILL_CATEGORY_ORDER, SKILL_CATEGORY_LABEL } from "@ceo/shared";
import { runAgent, specFromAgent } from "./agents.js";
import type { AgentContext } from "./agents.js";
import { loadAgent } from "./store.js";
import { db } from "./db.js";
import { streamClaude } from "./claude.js";
import { extractJsonWithFallback } from "./jsonUtil.js";
import { runTask } from "./tasks/index.js";
import type { TaskContext } from "./tasks/index.js";
import { decomposeTicket } from "./ctoDecompose.js";
import { diffWorktree } from "./git.js";

// ---- Public types -----------------------------------------------------------

export type DirectorConfig = SharedDirectorConfig;

export interface DirectorRunArgs {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  phase: WorkflowPhase;
  worktrees: { repo_name: string; repo_path: string; base_branch: string; path: string }[];
  cwd: string;
  /** Episodic memory: last N succeeded runs in this project (markdown). */
  recentRuns?: string | null;
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
interface PlaybookPhaseAction { action: "run_playbook_phase"; phase_id: string; notes?: string }
interface DecomposeAction { action: "request_decompose"; reason: string }
interface DoneAction { action: "mark_done"; summary: string }
interface GiveUpAction { action: "give_up"; reason: string }
type DirectorAction = DispatchAction | CiGateAction | PlaybookPhaseAction | DecomposeAction | DoneAction | GiveUpAction;

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
/** Hard cap on dispatches of any single sub-agent in one Director run. The
 *  prompt asks for ≤4; this enforces it in code so a hallucinating Director
 *  cannot loop forever on the same agent. */
const MAX_DISPATCHES_PER_SUBAGENT = 4;

// ---- Main entry -------------------------------------------------------------

export async function runDirectorPhase(args: DirectorRunArgs): Promise<DirectorResult> {
  const cfg = (args.phase.director ?? args.project.workflow.director_config ?? {}) as DirectorConfig;
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

    // Code-level guardrails (defense in depth — prompt rules can be ignored).
    const guard = enforceGuardrails(action, history, args.project);
    if (guard) {
      args.emit("system", { msg: `Director guardrail: ${guard.reason}` });
      // Append a synthetic outcome so Director sees the rejection on the next turn.
      history.push({
        iteration: iter,
        decision,
        outcome: { kind: "terminal", status: "failed", reason: `guardrail: ${guard.reason}` },
      });
      // Do NOT terminate — let Director see the feedback and pick another action.
      continue;
    }

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

// ---- Guardrails -------------------------------------------------------------

/** Code-level rules that override Director's prompt instructions. Returns null
 *  if the action is allowed, or a rejection with a reason for the next turn.
 *
 *  The cap counts dispatches per *physical sub-agent name*, regardless of
 *  whether they were invoked via `dispatch` (free-form) or `run_playbook_phase`
 *  (canonical). Both end up calling dispatchSubagent which records the
 *  real agent name in history, so we
 *  resolve the action target to a name and compare against history. */
function enforceGuardrails(
  action: DirectorAction,
  history: TurnRecord[],
  project: ProjectWithRepos,
): { reason: string } | null {
  // Resolve the agent name this action would invoke (or null for non-dispatch).
  let targetName: string | null = null;
  if (action.action === "dispatch") {
    targetName = action.subagent;
  } else if (action.action === "run_playbook_phase") {
    const phase = project.workflow.phases.find((p) => p.id === action.phase_id);
    if (phase?.kind === "agent" && phase.agent_id) {
      targetName = project.agents.find((a) => a.id === phase.agent_id)?.name ?? null;
    }
  }
  // 1) Hard cap: same sub-agent dispatched too many times. Counts the
  //    physical name so a playbook-phase invocation and a direct dispatch
  //    of the same agent share the budget.
  if (targetName) {
    const count = history.filter(
      (t) => t.outcome.kind === "subagent" && t.outcome.subagent === targetName,
    ).length;
    if (count >= MAX_DISPATCHES_PER_SUBAGENT) {
      return {
        reason: `Sub-agent "${targetName}" already dispatched ${count}× (cap ${MAX_DISPATCHES_PER_SUBAGENT}). Pick a different sub-agent, escalate, request_decompose, or give_up.`,
      };
    }
  }
  // 2) mark_done requires at least one successful ci_gate in this run.
  if (action.action === "mark_done") {
    const ciGreen = history.some((t) => t.outcome.kind === "ci_gate" && t.outcome.ok === true);
    if (!ciGreen) {
      return {
        reason: `mark_done blocked: no successful ci_gate in this run. Run ci_gate (or run_playbook_phase ci_gate) and confirm it passed before marking done.`,
      };
    }
  }
  return null;
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
  const cfg = (args.phase.director ?? args.project.workflow.director_config ?? {}) as DirectorConfig;
  const systemPrompt = buildDirectorSystemPrompt(budget.subagents, cfg, args.project);

  // Try once normally; if Director returns unparseable output, retry once with
  // a strict reminder. Avoids burning a give_up on a one-off formatting glitch.
  let { decision, cost } = await callDirectorOnce(args, systemPrompt, buildDirectorTurnPrompt(args, history, budget));
  if (decision.action.action === "give_up" && decision.rationale.startsWith("Could not parse")) {
    args.emit("system", { msg: "Director returned unparseable output — retrying with strict-JSON reminder." });
    const strictPrompt = buildDirectorTurnPrompt(args, history, budget) +
      "\n\nIMPORTANT: your previous reply was not parseable as JSON. Reply with ONE valid JSON object on the LAST line, no markdown fence required. Nothing after the JSON.";
    const retry = await callDirectorOnce(args, systemPrompt, strictPrompt);
    decision = retry.decision;
    cost += retry.cost;
  }
  return { decision, cost };
}

async function callDirectorOnce(
  args: DirectorRunArgs,
  systemPrompt: string,
  prompt: string,
): Promise<DirectorCallReturn> {
  let stdoutBuf = "";
  let cost = 0;
  const { promise, cancel } = streamClaude(
    { prompt, systemPrompt, cwd: args.cwd, model: DIRECTOR_MODEL },
    {
      onLine: (line) => {
        stdoutBuf += line + "\n";
        try {
          const ev = JSON.parse(line);
          if (ev?.type === "result" && typeof ev.total_cost_usd === "number") {
            cost = ev.total_cost_usd;
          }
        } catch { /* not JSON */ }
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
  // Named Playbook registry dropped — used <15% of the time and Director's
  // ad-hoc dispatch chains hit similar cost. Schema kept for back-compat.
  void project;
  // Teams concept dropped — SkillCategory on each phase already groups
  // agents by capability for Director's prompt. The Skills library section
  // below is rendered in category groups, which makes the Teams section
  // redundant labelware.
  void project;

  return `You are the Director — the lead orchestrator on this project. You are a tech lead who delegates work; you DO NOT write code or modify files yourself.

Your only output is a single JSON object describing the next action. The runtime executes it and reports back. Be terse. Reflect, decide, move on.

## Project: ${project.name}

${project.description || "(no description)"}

${cfg.project_brief ? `## Project brief\n${cfg.project_brief}\n` : ""}

## Skills + gates available (grouped by capability)

${playbook}

The library above is organized by what each skill/gate does, not by step order. You decide which to use, in what sequence, based on the ticket. Always close with a Validation gate (ci_gate) before mark_done.


## Available actions

\`\`\`
{ "action": "dispatch", "subagent": "<name>", "notes": "<concrete instructions>" }
{ "action": "run_playbook_phase", "phase_id": "<skill-or-gate-id>", "notes": "<optional override>" }
{ "action": "run_ci_gate" }
{ "action": "request_decompose", "reason": "<why split>" }
{ "action": "mark_done", "summary": "<what was delivered>" }
{ "action": "give_up", "reason": "<concrete blocker>" }
\`\`\`

- \`run_playbook_phase\` runs ONE skill/gate from the library with its configured agent and notes. Use when you want the canonical version of a step (e.g. \`ci_gate\`, \`reviewer\`).
- \`dispatch\` is the most flexible: ad-hoc agent invocation with custom notes — use for novel work or when adapting a known skill to a new context.
- \`run_ci_gate\` is shorthand for the canonical CI gate.

### Available sub-agents for dispatch:
${subagentList}

## Strategy rules

You are the routing brain — there is no separate Tech Lead. **You decide** whether the ticket needs planning, who codes it, what gates run, and when it's done. The skill registry above is your team; the rules below tell you when to reach for whom.

### How to size a ticket on the FIRST turn

Read the title + body + episodic memory. Pick ONE bucket:

- **Trivial** — single file, well-known pattern (new endpoint following an existing one, typo fix, small bugfix, dep bump). _Skip planning._ → \`dispatch\` Junior (Haiku) with concrete notes referencing the existing pattern.
- **Standard feature** — non-trivial business logic, multi-file but coherent (one component, no infra). _Skip planning if the spec is unambiguous._ → Junior or Senior depending on whether the spec mentions security / perf / migrations (those want Senior). Run Reviewer + ci_gate before close.
- **Design-needed** — touches multiple components, introduces a new pattern, has security or migration implications, > 1 day work. → \`run_playbook_phase architect\` first to produce plan.md, then dispatch coder per the plan.
- **Pure infra** — Dockerfile / docker-compose / nginx / php.ini / CI / deploy / .env / runtime config; ZERO app source files. → \`run_playbook_phase devops\` then \`run_playbook_phase devops_review\`. Skip the dev coders.
- **Cross-cutting** — needs BOTH infra changes AND app code. _Don't try to do both in one run._ → \`request_decompose\` immediately. CTO will produce a clean infra subticket + one or more code subtickets.

### Cost and escalation

1. **Start cheap.** Junior (Haiku) handles bulk. Reach for Senior (Opus) only when: Junior bounced twice on the same problem, OR ticket involves complex business logic, multi-file refactor, security-sensitive code, or perf-critical paths.
2. **Reflect every turn.** Look at the last 1–2 outcomes before deciding. Do not repeat an action that just failed identically.
3. **Hard cap.** Same sub-agent ≤ 4 dispatches per run (enforced in code). After 3 cycles with no progress, \`request_decompose\` or \`give_up\` — don't loop forever.

### Closing a run

4. **ci_gate before mark_done — always.** Code-enforced: \`mark_done\` is rejected if no \`ci_gate\` succeeded earlier in this run. After fixes, re-run ci_gate.
5. **Reviewer / Closer are not always required** — for trivial tickets, Junior + ci_gate + Closer (light sign-off) is enough. For everything else, Reviewer between code and ci_gate is a strong default.
6. **Tester** runs automated tests separately from ci_gate; use it when ci_gate doesn't already exercise the test suite.

### Notes & dispatch quality

7. **Notes are CONCRETE.** "Add /version endpoint to api/ following HealthController pattern, smoke test required, no shell_exec" — NOT "do the ticket". Include file paths, function names, acceptance criteria, gotchas you noticed in episodic memory.
8. **One dispatch = one focused outcome.** Don't ask Junior to "implement and review and test" in one shot — that's three skills.

## Output format

Reply with ONE JSON object on the LAST line of your response. Optionally include short reasoning above; the runtime only reads the last JSON.

\`\`\`json
{
  "rationale": "<1-2 sentences>",
  "action": { ... one of the actions above ... }
}
\`\`\``;
}

// renderTeams() removed — Teams concept dropped in favour of SkillCategory
// (each phase already carries a category that groups agents by capability,
// which is the same axis the Teams section was duplicating).

// renderPlaybookRegistry() removed — named Playbooks fired ~10% of the
// time and Director's ad-hoc dispatch chain hit comparable cost. Schema
// still carries WorkflowDefinition.playbooks for back-compat with existing
// project data; the engine simply doesn't surface it any more.

function renderPlaybook(project: ProjectWithRepos): string {
  const phases = (project.workflow.phases ?? []).filter((p) => p.kind !== "director");
  if (phases.length === 0) return "(no playbook phases — workflow is Director-only; you must drive entirely from the sub-agent registry)";
  const agentById = new Map(project.agents.map((a) => [a.id, a]));

  // Group phases by capability category. Director should think "what kind of
  // help do I need" (planning / coding / review / validation / closing) rather
  // than "what's the next edge in the graph".
  const byCategory = new Map<SkillCategory, WorkflowPhase[]>();
  for (const p of phases) {
    const agent = p.agent_id ? agentById.get(p.agent_id) : null;
    const cat = deriveSkillCategory(p, agent ? { name: agent.name, role: agent.role } : null);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }

  const sections: string[] = [];
  for (const cat of SKILL_CATEGORY_ORDER) {
    const phasesInCat = byCategory.get(cat);
    if (!phasesInCat || phasesInCat.length === 0) continue;
    sections.push(`### ${SKILL_CATEGORY_LABEL[cat]}`);
    for (const p of phasesInCat) {
      const kind = p.kind ?? "agent";
      let head = `- **${p.id}**`;
      if (kind === "agent" && p.agent_id) {
        const a = agentById.get(p.agent_id);
        head += a ? ` → ${a.name} (${a.role}${a.model ? `, ${a.model}` : ""})` : ` → agent ${p.agent_id} (missing)`;
      } else if (kind === "task" && p.task) {
        head += ` → ${p.task.type} gate`;
        if (p.task.type === "shell") {
          const cmd = String((p.task.config as Record<string, unknown>)?.command ?? "");
          const oneliner = cmd.split("\n")[0]?.slice(0, 80) ?? "";
          if (oneliner) head += ` (\`${oneliner}${cmd.includes("\n") ? " …" : ""}\`)`;
        }
      } else if (kind === "approval") {
        head += " → human approval";
      }
      sections.push(head);
      if (p.notes) sections.push(`    notes: ${p.notes.slice(0, 200)}${p.notes.length > 200 ? "…" : ""}`);
      // Note: next / retry_target / routes / max_attempts are no longer
      // rendered. Those were graph-canvas hints; orchestration belongs to
      // run_playbook_phase (canonical step) and code-level guardrails. Keeping the
      // schema fields for back-compat with old workflows but they no
      // longer leak into Director's prompt.
    }
    sections.push("");
  }
  return sections.join("\n").trim();
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
  // Episodic memory: only on the first turn (saves tokens on subsequent turns
  // where the active history is more relevant).
  if (history.length === 0 && args.recentRuns && args.recentRuns.trim()) {
    parts.push("", "## Recent work in this project (episodic memory)", args.recentRuns.trim());
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
  // Reflect the live sub-agent in the runs row so the Kanban card +
  // CategoryLanes strip + active-runs API show who's actually coding,
  // not the stale "director" label that was set when the phase started.
  // Reset to "director" in the finally-block below so the run looks like
  // Director again between dispatches.
  db.prepare(
    "UPDATE runs SET agent_role = ?, current_agent_name = ? WHERE id = ?",
  ).run(dbAgent.role, dbAgent.name, args.runId);

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

  // After dispatch returns (success or crash) we always restore the runs
  // row to "director" so the next Director-think shows up that way until
  // the next dispatch overwrites it again.
  const restoreDirector = () => {
    db.prepare(
      "UPDATE runs SET agent_role = ?, current_agent_name = ? WHERE id = ?",
    ).run("director", "director", args.runId);
  };

  let r;
  try {
    r = await runAgent(spec, ctx, handlers, args.registerCancel);
    args.unregisterCancel();
    restoreDirector();
  } catch (e: unknown) {
    args.unregisterCancel();
    restoreDirector();
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
