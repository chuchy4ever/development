/**
 * Director-pattern orchestration — top-level agent dispatching sub-agents.
 *
 * STATUS: SKELETON — not wired into the engine yet. See DIRECTOR-PATTERN.md
 * at the repo root for the design and what's still TODO.
 *
 * The idea: instead of a static phase graph, ONE Director agent (Sonnet) makes
 * decisions turn-by-turn:
 *   - "dispatch Junior with these notes"
 *   - "run ci_gate"
 *   - "mark done"
 *   - "give up"
 *
 * Each decision is a single Claude call (~$0.20-0.40). Sub-agent dispatches
 * reuse the existing `runAgent` machinery — no new prompts needed for Junior /
 * Senior / Reviewer / etc.
 *
 * Plug into runs.ts as a new phase kind:
 *
 *   if (phase.kind === "director") {
 *     const result = await runDirectorPhase({...});
 *     emit phase_end ...;
 *     break;
 *   }
 */

import type {
  ProjectWithRepos,
  Ticket,
  WorkflowPhase,
} from "@ceo/shared";
import { runAgent, specFromAgent } from "./agents.js";
import type { AgentContext } from "./agents.js";
import { loadAgent } from "./store.js";
import { runClaude } from "./claude.js";

// ---- Public types -----------------------------------------------------------

export interface DirectorConfig {
  /** Project-specific brief appended to Director's system prompt. */
  project_brief?: string;
  /** Hard guard against runaway loops. */
  max_iterations?: number;
  /** Total budget in USD across Director + sub-agents. */
  budget_usd?: number;
  /** Subset of project agents Director may dispatch. Defaults to all. */
  available_subagents?: string[];
}

export interface DirectorRunArgs {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  phase: WorkflowPhase;
  worktrees: { repo_name: string; path: string }[];
  cwd: string;
  emit: (event: string, payload: Record<string, unknown>) => void;
}

export interface DirectorResult {
  ok: boolean;
  summary: string;
  iterations: number;
  total_cost_usd: number;
}

// ---- Director decision schema ----------------------------------------------

type DirectorAction =
  | { action: "dispatch"; subagent: string; notes: string }
  | { action: "run_ci_gate" }
  | { action: "request_decompose"; reason: string }
  | { action: "mark_done"; summary: string }
  | { action: "give_up"; reason: string };

interface DirectorDecision extends Partial<Record<string, unknown>> {
  rationale: string;
  action: DirectorAction;
}

interface TurnRecord {
  iteration: number;
  decision: DirectorDecision;
  outcome:
    | { kind: "subagent_verdict"; subagent: string; ok: boolean | null; summary: string; commits_added: number }
    | { kind: "ci_gate"; ok: boolean; details: string }
    | { kind: "decompose"; subticket_count: number }
    | { kind: "terminal"; status: "succeeded" | "failed" };
}

// ---- Main entry -------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_BUDGET_USD = 8;

export async function runDirectorPhase(args: DirectorRunArgs): Promise<DirectorResult> {
  const cfg = (args.phase.director ?? {}) as DirectorConfig;
  const maxIter = cfg.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const budget = cfg.budget_usd ?? DEFAULT_BUDGET_USD;

  const history: TurnRecord[] = [];
  let totalCost = 0;
  let iter = 0;

  args.emit("director_start", {
    max_iterations: maxIter,
    budget_usd: budget,
    available_subagents: resolveAvailableSubagents(args, cfg),
  });

  while (iter < maxIter) {
    iter++;

    if (totalCost >= budget) {
      args.emit("director_end", { reason: "budget_exhausted", total_cost_usd: totalCost });
      return { ok: false, summary: `Budget exhausted at $${totalCost.toFixed(2)} / $${budget}`, iterations: iter, total_cost_usd: totalCost };
    }

    // 1. Ask Director what to do next.
    const decision = await callDirector(args, history, { totalCost, budget, iter, maxIter });
    totalCost += decision.cost;
    args.emit("director_decision", {
      iteration: iter,
      rationale: decision.parsed.rationale,
      action: decision.parsed.action,
      cost_usd: decision.cost,
    });

    const action = decision.parsed.action;

    // 2. Terminal actions.
    if (action.action === "mark_done") {
      history.push({ iteration: iter, decision: decision.parsed, outcome: { kind: "terminal", status: "succeeded" } });
      args.emit("director_end", { reason: "mark_done", total_cost_usd: totalCost });
      return { ok: true, summary: action.summary, iterations: iter, total_cost_usd: totalCost };
    }
    if (action.action === "give_up") {
      history.push({ iteration: iter, decision: decision.parsed, outcome: { kind: "terminal", status: "failed" } });
      args.emit("director_end", { reason: "give_up", total_cost_usd: totalCost });
      return { ok: false, summary: action.reason, iterations: iter, total_cost_usd: totalCost };
    }
    if (action.action === "request_decompose") {
      // TODO: call ctoDecompose.decomposeTicket(...) and treat as terminal.
      args.emit("director_end", { reason: "decompose_requested", total_cost_usd: totalCost });
      return { ok: true, summary: `Decompose requested: ${action.reason}`, iterations: iter, total_cost_usd: totalCost };
    }

    // 3. Sub-agent / task dispatches.
    if (action.action === "dispatch") {
      const outcome = await dispatchSubagent(args, action.subagent, action.notes, history);
      totalCost += outcome.cost;
      history.push({
        iteration: iter,
        decision: decision.parsed,
        outcome: {
          kind: "subagent_verdict",
          subagent: action.subagent,
          ok: outcome.ok,
          summary: outcome.summary,
          commits_added: outcome.commits_added,
        },
      });
      continue;
    }

    if (action.action === "run_ci_gate") {
      // TODO: invoke the same shell-task ci_gate command from project workflow.
      // For now stub:
      const outcome = { ok: false, details: "ci_gate not yet implemented in director skeleton" };
      history.push({ iteration: iter, decision: decision.parsed, outcome: { kind: "ci_gate", ...outcome } });
      args.emit("system", { msg: "Director ci_gate stub returned: " + outcome.details });
      continue;
    }
  }

  args.emit("director_end", { reason: "max_iterations", total_cost_usd: totalCost });
  return { ok: false, summary: `Hit max_iterations=${maxIter}`, iterations: iter, total_cost_usd: totalCost };
}

// ---- Director call (single Claude turn) -------------------------------------

interface DirectorCallResult {
  parsed: DirectorDecision;
  cost: number;
}

async function callDirector(
  args: DirectorRunArgs,
  history: TurnRecord[],
  budget: { totalCost: number; budget: number; iter: number; maxIter: number },
): Promise<DirectorCallResult> {
  const subagents = resolveAvailableSubagents(args, (args.phase.director ?? {}) as DirectorConfig);
  const systemPrompt = buildDirectorSystemPrompt(subagents, args);
  const prompt = buildDirectorTurnPrompt(args, history, budget);

  // Use claude CLI in JSON output mode so we can parse cost reliably.
  const res = await runClaude({
    prompt,
    systemPrompt,
    cwd: args.cwd,
    json: true,
  });

  // TODO: extract total_cost_usd from claude result envelope.
  // For skeleton, fake it.
  const cost = 0.25;

  // TODO: robust JSON extraction (use existing extractJsonWithFallback).
  let parsed: DirectorDecision;
  try {
    parsed = JSON.parse(res.stdout) as DirectorDecision;
  } catch (e) {
    parsed = {
      rationale: "PARSE_ERROR — raw: " + res.stdout.slice(0, 200),
      action: { action: "give_up", reason: "Director output unparseable" },
    };
  }
  return { parsed, cost };
}

function buildDirectorSystemPrompt(subagents: string[], args: DirectorRunArgs): string {
  const cfg = (args.phase.director ?? {}) as DirectorConfig;
  return `You are the Director — the lead orchestrator for ticket ${args.ticket.ticket_key ?? args.ticket.id} in project ${args.project.name}.

You CANNOT write code or modify files yourself. Your only output is a JSON
decision describing the next action. The runtime executes it and reports back.

## Available actions

- dispatch <subagent>(notes): hand work to a sub-agent. Available subagents:
  ${subagents.map((s) => `  · ${s}`).join("\n  ")}
- run_ci_gate: run the project's CI command in Docker. Returns pass/fail + tail.
- request_decompose(reason): if the ticket spans multiple unrelated concerns, hand to CTO.
- mark_done(summary): all acceptance criteria are met. Run ends as succeeded.
- give_up(reason): you're stuck. Run ends as failed. Use sparingly.

## Rules

- Reflect each turn. Reflect on what's been done, what's left.
- Start cheap: dispatch Junior + Reviewer cycles. Escalate to Senior only when
  Junior bounces twice on the same blocker, or Reviewer surfaces architectural issues.
- Hard limit: do not dispatch the same subagent more than 4 times.
- Run ci_gate before mark_done. If ci_gate fails, dispatch the right subagent
  to fix; if it fails twice for the same root cause, give_up.
- Do not narrate your reasoning at length. The 'rationale' field stays under 2 sentences.

## Output format (JSON only, on the LAST line of your reply, no fences)

{
  "rationale": "<1-2 sentences>",
  "action": {
    "action": "dispatch" | "run_ci_gate" | "request_decompose" | "mark_done" | "give_up",
    // for "dispatch":
    "subagent": "<subagent name>",
    "notes": "<notes for the subagent>",
    // for others:
    "summary": "<for mark_done>",
    "reason": "<for give_up / request_decompose>"
  }
}

${cfg.project_brief ? `## Project brief\n${cfg.project_brief}\n` : ""}`;
}

function buildDirectorTurnPrompt(args: DirectorRunArgs, history: TurnRecord[], budget: { totalCost: number; budget: number; iter: number; maxIter: number }): string {
  const lines: string[] = [
    `# Ticket: ${args.ticket.title}`,
    "",
    args.ticket.body || "(no body)",
    "",
    `## Repos in this run`,
    ...args.worktrees.map((w) => `- ${w.repo_name} at ${w.path}`),
    "",
    `## Budget`,
    `- iteration ${budget.iter}/${budget.maxIter}`,
    `- spent $${budget.totalCost.toFixed(2)} / $${budget.budget.toFixed(2)}`,
    "",
    `## History (most recent ${Math.min(history.length, 8)} turns)`,
  ];
  const recent = history.slice(-8);
  if (recent.length === 0) {
    lines.push("(none yet — this is your first decision)");
  } else {
    for (const t of recent) {
      lines.push(`### Turn ${t.iteration}`);
      lines.push(`- decision: ${t.decision.action.action}${"subagent" in t.decision.action ? ` ${t.decision.action.subagent}` : ""}`);
      lines.push(`- rationale: ${t.decision.rationale}`);
      lines.push(`- outcome: ${JSON.stringify(t.outcome)}`);
    }
  }
  lines.push("");
  lines.push("Decide the next action. Reply with JSON ONLY on the last line.");
  return lines.join("\n");
}

// ---- Sub-agent dispatch -----------------------------------------------------

function resolveAvailableSubagents(args: DirectorRunArgs, cfg: DirectorConfig): string[] {
  if (cfg.available_subagents && cfg.available_subagents.length > 0) {
    return cfg.available_subagents;
  }
  // Default: all project agents excluding meta agents (CTO, Memory Curator).
  return args.project.agents
    .map((a) => a.name)
    .filter((n) => !["CTO", "Memory Curator"].includes(n));
}

interface SubagentDispatchResult {
  ok: boolean | null;
  summary: string;
  commits_added: number;
  cost: number;
}

async function dispatchSubagent(
  args: DirectorRunArgs,
  subagentName: string,
  notes: string,
  _history: TurnRecord[],
): Promise<SubagentDispatchResult> {
  const agent = args.project.agents.find((a) => a.name === subagentName);
  if (!agent) {
    return { ok: false, summary: `unknown subagent "${subagentName}"`, commits_added: 0, cost: 0 };
  }
  const dbAgent = loadAgent(agent.id);
  if (!dbAgent) {
    return { ok: false, summary: `agent "${subagentName}" not in DB`, commits_added: 0, cost: 0 };
  }

  args.emit("director_dispatch", { subagent: subagentName, notes: notes.slice(0, 200) });

  const spec = specFromAgent(dbAgent);
  const ctx: AgentContext = {
    project: args.project,
    ticket: args.ticket,
    worktrees: args.worktrees,
    cwd: args.cwd,
    phaseNotes: notes,
    diffs: "", // TODO: compute diff from worktrees
    pipelineContext: null, // TODO: synth a "you are working under Director, expect another turn after"
  };

  // TODO: capture cost from the agent run. For now stub.
  const handlers = {
    onLine: () => {},
    onStderr: () => {},
  };
  const r = await runAgent(spec, ctx, handlers);

  // TODO: count commits before/after to fill commits_added.
  return {
    ok: (r.verdict as { ok?: boolean } | null)?.ok ?? null,
    summary: (r.verdict as { summary?: string } | null)?.summary ?? r.finalText.slice(0, 200),
    commits_added: 0,
    cost: 0, // TODO
  };
}
