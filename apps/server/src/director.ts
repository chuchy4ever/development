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
import { runTask, readTask } from "./tasks/index.js";
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
  /** Set when Director paused mid-run (e.g. budget exhausted) and should be
   *  resumed via decideApproval. The engine writes the run as `awaiting_approval`
   *  so the user can extend budget (approve) or cancel (reject). */
  paused?:
    | { reason: "budget_exhausted"; budget_usd: number }
    | { reason: "human_review"; question: string; rationale: string }
    | { reason: "max_iterations"; iterations: number; max_iterations: number };
}

// ---- Decision schema --------------------------------------------------------

interface DispatchAction { action: "dispatch"; subagent: string; notes: string }
interface CiGateAction { action: "run_ci_gate" }
interface PlaybookPhaseAction { action: "run_playbook_phase"; phase_id: string; notes?: string }
interface DecomposeAction { action: "request_decompose"; reason: string }
interface DoneAction { action: "mark_done"; summary: string }
interface GiveUpAction { action: "give_up"; reason: string }
/** Pull external data from one of the project's configured connectors so the
 *  next dispatch can include it in the sub-agent's notes. Result is logged
 *  to run_events as `director_context_fetched` and replayed on resume. */
interface FetchContextAction {
  action: "fetch_context";
  connector: "jira" | "github" | "ssh";
  /** Connector-specific params; see TaskReadParams in tasks/types.ts. */
  params: Record<string, unknown>;
}
/** Dispatch multiple read-only sub-agents (Reviewer, Tester, Lint Gate, …)
 *  concurrently against the same worktree. They share the diff but each
 *  produces its own verdict. Director sees aggregated outcomes on the next
 *  turn and can react to ALL findings at once instead of fixing iteratively.
 *
 *  Code-enforced: each sub-agent in `targets` must have role `reviewer`. Coder
 *  parallelism is disallowed until we add per-dispatch worktree branches +
 *  merge logic. */
interface DispatchParallelAction {
  action: "dispatch_parallel";
  targets: Array<{ subagent: string; notes: string }>;
}
/** Pause the run for human input. Surfaces as awaiting_approval in the UI;
 *  user can approve (run resumes from next iteration with the answer in
 *  history) or reject (run cancels). Use sparingly — for ambiguous specs,
 *  irreversible decisions (deletes, deploys), or plan sign-off before code. */
interface RequestHumanReviewAction {
  action: "request_human_review";
  /** Short rationale shown above the question. */
  rationale: string;
  /** The actual question to the user (concrete, not "should I proceed?"). */
  question: string;
}
type DirectorAction =
  | DispatchAction | CiGateAction | PlaybookPhaseAction
  | DecomposeAction | DoneAction | GiveUpAction
  | FetchContextAction | RequestHumanReviewAction | DispatchParallelAction;

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
  /** When set, identifies which workflow phase emitted this outcome. Used by
   *  enforceGuardrails to require specific gates (git_push) green before
   *  mark_done. Unset for the canonical ci_gate (legacy behavior). */
  phase_id?: string;
  /** Optional task type tag — lets guardrails check "any git_push green"
   *  without knowing the user's phase_id naming. */
  task_type?: string;
}
interface TerminalOutcome {
  kind: "terminal";
  status: "succeeded" | "failed" | "decomposed";
  reason: string;
}
interface ContextFetchedOutcome {
  kind: "context_fetched";
  connector: string;
  ok: boolean;
  /** Markdown summary returned by the connector (or empty on failure). */
  content: string;
  error?: string;
}
interface HumanReviewOutcome {
  kind: "human_review";
  /** True if user clicked Approve, false on Reject. */
  approved: boolean;
  /** Free-text response the user typed. May be empty. */
  note: string;
}
interface ParallelDispatchOutcome {
  kind: "parallel_dispatch";
  /** Per-sub-agent results. Order matches the requested targets. */
  results: SubagentOutcome[];
  total_cost_usd: number;
  /** True if every sub-agent returned ok=true. */
  all_ok: boolean;
}
type Outcome =
  | SubagentOutcome | CiGateOutcome | TerminalOutcome
  | ContextFetchedOutcome | HumanReviewOutcome | ParallelDispatchOutcome;

interface TurnRecord {
  iteration: number;
  decision: DirectorDecision;
  outcome: Outcome;
}

// ---- History rebuild --------------------------------------------------------

/** Reconstruct Director's in-memory history from `director_decision` and
 *  `director_subagent_done` events. Lets a resumed run (paused for budget,
 *  awaiting_approval, or server restart) continue without re-running prior
 *  turns. Total cost is summed from event payloads to recover spend exactly. */
function rebuildHistoryFromEvents(
  runId: string,
): { history: TurnRecord[]; totalCost: number; lastIter: number } {
  const events = db
    .prepare(
      `SELECT type, payload FROM run_events
        WHERE run_id = ? AND type IN ('director_decision', 'director_subagent_done', 'director_context_fetched', 'director_human_review_resolved')
        ORDER BY id ASC`,
    )
    .all(runId) as { type: string; payload: string }[];

  const history: TurnRecord[] = [];
  let totalCost = 0;
  let lastIter = 0;
  let pending: { iteration: number; decision: DirectorDecision } | null = null;

  const flushTerminalPending = () => {
    if (!pending) return;
    const a = pending.decision.action;
    if (a.action === "mark_done") {
      history.push({
        iteration: pending.iteration,
        decision: pending.decision,
        outcome: { kind: "terminal", status: "succeeded", reason: a.summary },
      });
    } else if (a.action === "give_up") {
      history.push({
        iteration: pending.iteration,
        decision: pending.decision,
        outcome: { kind: "terminal", status: "failed", reason: a.reason },
      });
    }
    // request_decompose terminates with a separate path; not reconstructable
    // from these events alone — but we never pause after decompose, so resume
    // doesn't need to see it.
    pending = null;
  };

  for (const ev of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "director_decision") {
      flushTerminalPending();
      const action = payload.action as DirectorAction | undefined;
      if (!action) continue;
      const iteration = Number(payload.iteration ?? 0);
      pending = {
        iteration,
        decision: { rationale: String(payload.rationale ?? ""), action },
      };
      if (iteration > lastIter) lastIter = iteration;
      totalCost += Number(payload.cost_usd ?? 0);
    } else if (ev.type === "director_subagent_done" && pending) {
      let outcome: Outcome;
      const subName = String(payload.subagent ?? "?");
      if (subName === "ci_gate" || subName.startsWith("task:")) {
        outcome = {
          kind: "ci_gate",
          ok: !!payload.ok,
          summary: String(payload.summary ?? ""),
          details_tail: "",
          phase_id: typeof payload.phase_id === "string" ? payload.phase_id : (subName.startsWith("task:") ? subName.slice("task:".length) : undefined),
          task_type: typeof payload.task_type === "string" ? payload.task_type : undefined,
        };
      } else if (subName === "parallel" && Array.isArray(payload.parallel_results)) {
        const subResults: SubagentOutcome[] = (payload.parallel_results as Array<Record<string, unknown>>).map((r) => ({
          kind: "subagent",
          subagent: String(r.subagent ?? "?"),
          ok: (r.ok as boolean | null | undefined) ?? null,
          summary: String(r.summary ?? ""),
          issues: Array.isArray(r.issues) ? (r.issues as { severity?: string; message?: string }[]) : [],
          commits_added: 0,
          cost_usd: Number(r.cost_usd ?? 0),
        }));
        const total = Number(payload.cost_usd ?? subResults.reduce((s, r) => s + r.cost_usd, 0));
        outcome = {
          kind: "parallel_dispatch",
          results: subResults,
          total_cost_usd: total,
          all_ok: subResults.every((r) => r.ok === true),
        };
        totalCost += total;
      } else {
        const subagentCost = Number(payload.cost_usd ?? 0);
        outcome = {
          kind: "subagent",
          subagent: subName,
          ok: (payload.ok as boolean | null | undefined) ?? null,
          summary: String(payload.summary ?? ""),
          issues: [],
          commits_added: Number(payload.commits_added ?? 0),
          cost_usd: subagentCost,
        };
        totalCost += subagentCost;
      }
      history.push({ iteration: pending.iteration, decision: pending.decision, outcome });
      pending = null;
    } else if (ev.type === "director_context_fetched" && pending) {
      const outcome: ContextFetchedOutcome = {
        kind: "context_fetched",
        connector: String(payload.connector ?? "?"),
        ok: !!payload.ok,
        content: String(payload.content ?? ""),
        error: typeof payload.error === "string" ? payload.error : undefined,
      };
      history.push({ iteration: pending.iteration, decision: pending.decision, outcome });
      pending = null;
    } else if (ev.type === "director_human_review_resolved" && pending) {
      const outcome: HumanReviewOutcome = {
        kind: "human_review",
        approved: !!payload.approved,
        note: String(payload.note ?? ""),
      };
      history.push({ iteration: pending.iteration, decision: pending.decision, outcome });
      pending = null;
    }
  }
  flushTerminalPending();

  return { history, totalCost, lastIter };
}

// ---- Constants --------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_BUDGET_USD = 20;
const DIRECTOR_MODEL = "claude-sonnet-4-6";
const SUBAGENT_BLACKLIST = new Set(["CTO", "Memory Curator", "Director"]);
/** Hard cap on dispatches of any single sub-agent in one Director run. The
 *  prompt asks for ≤4; this enforces it in code so a hallucinating Director
 *  cannot loop forever on the same agent. */
const MAX_DISPATCHES_PER_SUBAGENT = 4;

// ---- Main entry -------------------------------------------------------------

export async function runDirectorPhase(args: DirectorRunArgs): Promise<DirectorResult> {
  const cfg = (args.phase.director ?? args.project.workflow.director_config ?? {}) as DirectorConfig;
  // Per-run overrides (set when user approves an extension after a paused run)
  // take precedence over project config, which takes precedence over defaults.
  const overrideRow = db
    .prepare("SELECT director_budget_override_usd, director_max_iter_override FROM runs WHERE id = ?")
    .get(args.runId) as { director_budget_override_usd: number | null; director_max_iter_override: number | null } | undefined;
  const maxIter = overrideRow?.director_max_iter_override ?? cfg.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const budget =
    overrideRow?.director_budget_override_usd ?? cfg.budget_usd ?? DEFAULT_BUDGET_USD;

  // Rebuild history from persisted events so resumes (after pause or server
  // restart) pick up where we left off without re-paying for prior turns.
  const rebuilt = rebuildHistoryFromEvents(args.runId);
  const history: TurnRecord[] = rebuilt.history;
  let totalCost = rebuilt.totalCost;
  let iter = rebuilt.lastIter;

  const subagents = resolveAvailableSubagents(args.project, cfg);

  args.emit("director_start", {
    max_iterations: maxIter,
    budget_usd: budget,
    available_subagents: subagents,
    project_brief: cfg.project_brief ?? null,
    resumed_turns: history.length || undefined,
    resumed_cost_usd: history.length > 0 ? totalCost : undefined,
  });

  while (iter < maxIter) {
    iter++;

    if (totalCost >= budget) {
      // Pause (not fail) — caller writes the run as awaiting_approval so the
      // user can extend budget and resume, or cancel.
      args.emit("director_paused", {
        reason: "budget_exhausted",
        total_cost_usd: totalCost,
        budget_usd: budget,
        iterations: iter,
      });
      return {
        ok: false,
        summary: `Paused: budget $${budget.toFixed(2)} exhausted at $${totalCost.toFixed(2)}`,
        iterations: iter,
        total_cost_usd: totalCost,
        paused: { reason: "budget_exhausted", budget_usd: budget },
      };
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
        const result = await decomposeTicket(args.project, args.ticket, args.runId);
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

    if (action.action === "dispatch_parallel") {
      const outcome = await dispatchParallel(args, action.targets);
      totalCost += outcome.total_cost_usd;
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

    if (action.action === "fetch_context") {
      const outcome = await fetchContext(args, action);
      history.push({ iteration: iter, decision, outcome });
      continue;
    }

    if (action.action === "request_human_review") {
      args.emit("director_paused", {
        reason: "human_review",
        question: action.question,
        rationale: action.rationale,
        iterations: iter,
        total_cost_usd: totalCost,
      });
      return {
        ok: false,
        summary: `Awaiting human review: ${action.question}`,
        iterations: iter,
        total_cost_usd: totalCost,
        paused: { reason: "human_review", question: action.question, rationale: action.rationale },
      };
    }

    args.emit("system", { msg: `Director returned unknown action: ${JSON.stringify(action)}` });
    return { ok: false, summary: `Unknown action`, iterations: iter, total_cost_usd: totalCost };
  }

  // Out of iterations. Don't fail — pause as awaiting_approval so the user
  // can extend by +10 iterations and let Director finish (typically just
  // git_push + mark_done when CI is already green). Same UX as budget pause.
  args.emit("director_paused", {
    reason: "max_iterations",
    iterations: iter,
    max_iterations: maxIter,
    total_cost_usd: totalCost,
  });
  return {
    ok: false,
    summary: `Paused: hit max iterations (${maxIter}). Approve to extend by +10 and finish; reject to cancel.`,
    iterations: iter,
    total_cost_usd: totalCost,
    paused: { reason: "max_iterations", iterations: iter, max_iterations: maxIter },
  };
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
  // 1a) Junior escalation: after 3 Junior dispatches with at least one
  //     failed ci_gate in the history, force escalation to Senior. Director's
  //     prompt asks for the same but Director keeps re-dispatching Junior on
  //     trivial-looking PHPStan / lint errors that prove to be deeper than
  //     they look. This hard cap breaks the loop without waiting for the
  //     4× total cap. Identifies Junior by role=coder + name containing
  //     "Junior" (works for both "PHP Junior Coder" and bare "Junior Coder").
  if (targetName) {
    const targetAgent = project.agents.find((a) => a.name === targetName);
    if (targetAgent?.role === "coder" && /junior/i.test(targetName)) {
      const juniorDispatches = history.filter(
        (t) => t.outcome.kind === "subagent" && t.outcome.subagent === targetName,
      ).length;
      const ciFailures = history.filter(
        (t) => t.outcome.kind === "ci_gate" && t.outcome.ok === false,
      ).length;
      if (juniorDispatches >= 3 && ciFailures >= 1) {
        return {
          reason: `"${targetName}" already dispatched ${juniorDispatches}× and ci_gate has failed ${ciFailures}× — Junior had its shot at fixing CI. Escalate to a Senior-role coder (deeper expertise) or give_up with a concrete blocker. Don't re-dispatch Junior on the same failure.`,
        };
      }
    }
  }
  // 1b) dispatch_parallel: enforce read-only sub-agents (role=reviewer) only,
  //     reject empty / >4 targets, and apply per-subagent cap to each target.
  if (action.action === "dispatch_parallel") {
    if (action.targets.length === 0) {
      return { reason: "dispatch_parallel needs ≥1 target" };
    }
    if (action.targets.length > 4) {
      return { reason: `dispatch_parallel cap is 4 targets, got ${action.targets.length}` };
    }
    const seen = new Set<string>();
    for (const t of action.targets) {
      if (seen.has(t.subagent)) {
        return { reason: `dispatch_parallel: duplicate target "${t.subagent}" (each sub-agent only once per parallel batch)` };
      }
      seen.add(t.subagent);
      const agent = project.agents.find((a) => a.name === t.subagent);
      if (!agent) {
        return { reason: `dispatch_parallel: unknown sub-agent "${t.subagent}"` };
      }
      if (agent.role !== "reviewer") {
        return {
          reason: `dispatch_parallel: "${t.subagent}" has role "${agent.role}" — only reviewer-role sub-agents allowed (no concurrent code writers yet)`,
        };
      }
      const count = history.filter(
        (h) => h.outcome.kind === "subagent" && h.outcome.subagent === t.subagent,
      ).length + history.filter(
        (h) => h.outcome.kind === "parallel_dispatch" && h.outcome.results.some((r) => r.subagent === t.subagent),
      ).reduce((acc, h) => acc + (h.outcome.kind === "parallel_dispatch" ? h.outcome.results.filter((r) => r.subagent === t.subagent).length : 0), 0);
      if (count >= MAX_DISPATCHES_PER_SUBAGENT) {
        return { reason: `dispatch_parallel: "${t.subagent}" already dispatched ${count}× (cap ${MAX_DISPATCHES_PER_SUBAGENT})` };
      }
    }
  }
  // 1c) give_up blocked when the work is essentially done. Director isn't
  //     allowed to abandon a run if ci_gate is green and there's a concrete
  //     next step (git_push or mark_done) it hasn't tried. Common failure
  //     mode this catches: Director sees a flaky retry, gets pessimistic,
  //     and gives up despite the work being one turn from delivery.
  if (action.action === "give_up") {
    // Find most recent shell ci_gate result (the canonical CI), and the
    // most recent git_push gate result (when configured).
    let lastShellCiGreen: TurnRecord | null = null;
    let lastGitPushOutcome: TurnRecord | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const t = history[i]!;
      if (t.outcome.kind === "ci_gate" && t.outcome.ok === true && (t.outcome.task_type === "shell" || t.outcome.task_type === undefined)) {
        if (lastShellCiGreen === null) lastShellCiGreen = t;
      }
      if (t.outcome.kind === "ci_gate" && t.outcome.task_type === "git_push") {
        if (lastGitPushOutcome === null) lastGitPushOutcome = t;
      }
    }
    const hasGitPushGate = project.workflow.phases.some(
      (p) => p.kind === "task" && p.task?.type === "git_push",
    );
    if (lastShellCiGreen) {
      if (hasGitPushGate) {
        const gitPushTriedAfterCi =
          lastGitPushOutcome !== null && lastGitPushOutcome.iteration > lastShellCiGreen.iteration;
        const lastGitPushOk =
          lastGitPushOutcome !== null
          && lastGitPushOutcome.outcome.kind === "ci_gate"
          && lastGitPushOutcome.outcome.ok === true
          && lastGitPushOutcome.iteration > lastShellCiGreen.iteration;
        if (!gitPushTriedAfterCi) {
          return {
            reason: `give_up blocked: ci_gate passed (turn ${lastShellCiGreen.iteration}) and git_push hasn't been attempted since. Work is committed in the worktree — run \`run_playbook_phase git_push\` to land it, then mark_done. If git_push then fails persistently, give_up with the SPECIFIC push error.`,
          };
        }
        if (lastGitPushOk && lastGitPushOutcome) {
          return {
            reason: `give_up blocked: ci_gate is green AND git_push succeeded (turn ${lastGitPushOutcome.iteration}). The work is on origin. Just mark_done.`,
          };
        }
      } else {
        return {
          reason: `give_up blocked: ci_gate passed (turn ${lastShellCiGreen.iteration}) and no git_push gate is configured. Nothing else to verify — mark_done now.`,
        };
      }
    }
  }
  // 2) mark_done requires at least one successful ci_gate (any phase tagged
  //    or the canonical run_ci_gate action) in this run.
  if (action.action === "mark_done") {
    const ciGreen = history.some((t) =>
      t.outcome.kind === "ci_gate"
      && t.outcome.ok === true
      && (t.outcome.task_type === "shell" || t.outcome.task_type === undefined),
    );
    if (!ciGreen) {
      return {
        reason: `mark_done blocked: no successful ci_gate in this run. Run ci_gate (or run_playbook_phase ci_gate) and confirm it passed before marking done.`,
      };
    }
    // 3) If workflow has a git_push gate configured, the LAST git_push
    //    attempt must have succeeded. Push IS done — code that didn't reach
    //    the remote isn't delivered.
    const hasGitPushGate = project.workflow.phases.some(
      (p) => p.kind === "task" && p.task?.type === "git_push",
    );
    if (hasGitPushGate) {
      // Find the LAST git_push outcome (Director may have run it multiple
      // times; only the latest counts — that's the current state of origin).
      let lastGitPush: TurnRecord | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const t = history[i]!;
        if (t.outcome.kind === "ci_gate" && t.outcome.task_type === "git_push") {
          lastGitPush = t;
          break;
        }
      }
      if (!lastGitPush) {
        return {
          reason: `mark_done blocked: workflow has a git_push gate but it hasn't been run yet. Push code to remote before marking done — invoke run_playbook_phase with the git_push phase id (after ci_gate is green).`,
        };
      }
      if (lastGitPush.outcome.kind === "ci_gate" && lastGitPush.outcome.ok !== true) {
        return {
          reason: `mark_done blocked: last git_push attempt failed (${lastGitPush.outcome.summary.slice(0, 200)}). Either re-run git_push (it auto-retries transients), or give_up with a concrete reason.`,
        };
      }
    }
  }
  return null;
}

// ---- Director call (single Claude turn) -------------------------------------

interface DirectorCallReturn {
  decision: DirectorDecision;
  cost: number;
  /** Set when the claude CLI itself failed (non-zero exit + stderr matching
   *  rate-limit / network / timeout). callDirector retries on this with
   *  exponential backoff before falling through to parse-retry. */
  transient?: { reason: string };
}

/** Sniff stderr / exit status for a known transient claude CLI failure mode.
 *  Conservative — false positives just mean we retry an extra time, but false
 *  negatives mean a give_up that could have been recovered. */
function detectTransient(exitCode: number, stderr: string, stdoutBuf: string): { reason: string } | null {
  // Successful exit but possible rate-limit event in the stream.
  if (exitCode === 0) {
    if (/"type"\s*:\s*"rate_limit_event"/.test(stdoutBuf) && stdoutBuf.length < 500) {
      return { reason: "rate_limit_event in stream, no result" };
    }
    return null;
  }
  const tail = stderr.slice(-1000).toLowerCase();
  if (/rate.?limit|429/.test(tail)) return { reason: `rate limit (exit ${exitCode})` };
  if (/timeout|etimedout|timed out/.test(tail)) return { reason: `timeout (exit ${exitCode})` };
  if (/econnreset|enotfound|enetunreach|econnrefused|connection (reset|refused|closed)/.test(tail)) {
    return { reason: `network (exit ${exitCode})` };
  }
  if (/overloaded|service unavailable|503|502/.test(tail)) {
    return { reason: `upstream overloaded (exit ${exitCode})` };
  }
  return null;
}

async function callDirector(
  args: DirectorRunArgs,
  history: TurnRecord[],
  budget: { totalCost: number; budget: number; iter: number; maxIter: number; subagents: string[] },
): Promise<DirectorCallReturn> {
  const cfg = (args.phase.director ?? args.project.workflow.director_config ?? {}) as DirectorConfig;
  const systemPrompt = buildDirectorSystemPrompt(budget.subagents, cfg, args.project);
  const turnPrompt = buildDirectorTurnPrompt(args, history, budget);

  // Up to 3 attempts on transient claude CLI failures (rate limit, network,
  // timeout). Exponential backoff: 2s, 4s. Costs accumulate across attempts —
  // a transient that already burned tokens still counts toward budget.
  let cost = 0;
  let lastReturn: DirectorCallReturn | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await callDirectorOnce(args, systemPrompt, turnPrompt);
    cost += r.cost;
    if (!r.transient) {
      lastReturn = { decision: r.decision, cost };
      break;
    }
    if (attempt < 3) {
      const waitMs = 2000 * attempt;
      args.emit("system", {
        msg: `Director: transient claude failure (${r.transient.reason}) — retrying in ${waitMs}ms (attempt ${attempt + 1}/3)`,
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    // Final attempt also failed — fall through with whatever decision we got
    // (likely a give_up "Could not parse"). The run will be marked failed.
    lastReturn = {
      decision: {
        rationale: `Director call failed after 3 attempts (${r.transient.reason})`,
        action: { action: "give_up", reason: `transient claude failure: ${r.transient.reason}` },
      },
      cost,
    };
  }

  let { decision } = lastReturn!;

  // Parse-retry: if Director returned unparseable output (not transient), give
  // it one more shot with a strict reminder. Avoids burning a give_up on a
  // one-off formatting glitch.
  if (decision.action.action === "give_up" && decision.rationale.startsWith("Could not parse")) {
    args.emit("system", { msg: "Director returned unparseable output — retrying with strict-JSON reminder." });
    const strictPrompt = turnPrompt +
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
  let stderrBuf = "";
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
      onStderr: (chunk) => { stderrBuf += chunk; },
    },
  );
  args.registerCancel(cancel);
  const result = await promise;
  args.unregisterCancel();

  const transient = detectTransient(result.exitCode, stderrBuf, stdoutBuf);
  if (transient) {
    return {
      decision: {
        rationale: `transient claude failure: ${transient.reason}`,
        action: { action: "give_up", reason: transient.reason },
      },
      cost,
      transient,
    };
  }

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
  const connectors = describeReadableConnectors(project);
  const connectorSection = connectors.length === 0
    ? "(no readable connectors configured — fetch_context unavailable)"
    : connectors.map((c) => `  - **${c.type}**${c.hint ? ` — ${c.hint}` : ""}`).join("\n");
  const fetchExamples = connectors.length === 0 ? "" : connectors.map((c) => {
    if (c.type === "jira") return `{ "action": "fetch_context", "connector": "jira", "params": { "key": "DEV-1111" } }`;
    if (c.type === "github") return `{ "action": "fetch_context", "connector": "github", "params": { "kind": "pr", "repo": "owner/name", "number": 42 } }`;
    if (c.type === "ssh") return `{ "action": "fetch_context", "connector": "ssh", "params": { "path": "/etc/nginx/nginx.conf" } }`;
    return "";
  }).filter(Boolean).map((s) => `  ${s}`).join("\n");
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
{ "action": "dispatch_parallel", "targets": [ { "subagent": "<name>", "notes": "..." }, ... ] }
{ "action": "run_playbook_phase", "phase_id": "<skill-or-gate-id>", "notes": "<optional override>" }
{ "action": "run_ci_gate" }
{ "action": "fetch_context", "connector": "<jira|github|ssh>", "params": { ... } }
{ "action": "request_human_review", "rationale": "<why you need input>", "question": "<concrete question to user>" }
{ "action": "request_decompose", "reason": "<why split>" }
{ "action": "mark_done", "summary": "<what was delivered>" }
{ "action": "give_up", "reason": "<concrete blocker>" }
\`\`\`

- \`run_playbook_phase\` runs ONE skill/gate from the library with its configured agent and notes. Use when you want the canonical version of a step (e.g. \`ci_gate\`, \`reviewer\`).
- \`dispatch\` is the most flexible: ad-hoc agent invocation with custom notes — use for novel work or when adapting a known skill to a new context.
- \`run_ci_gate\` is shorthand for the canonical CI gate.
- \`dispatch_parallel\` runs 2–4 **read-only** sub-agents (Reviewer, Tester, Lint Gate, Security Reviewer) **concurrently** against the same diff. Use when you want all findings at once instead of fixing iteratively. Code-enforced: targets must have role=reviewer; coders cannot be parallelized (no concurrent worktree writes yet). After the batch returns, the next turn sees ALL verdicts together — quote the relevant findings in the next dispatch's notes.
- \`fetch_context\` pulls external data into the run from a configured connector. Result lands in your history and is visible on the next turn — quote the relevant parts in the next \`dispatch\` notes so the sub-agent has the context.
- \`request_human_review\` pauses the run and asks the user a question. **AUTONOMY IS THE DEFAULT** — the user does not want to be asked. Only use this for operations that are **truly irreversible** AND **high-impact**: dropping a table or column that contains data, deleting users / customer records, force-pushing to a protected branch, deploying to production, mass-emailing customers, charging cards. Architectural and design ambiguity is NOT a reason — pick the simplest reasonable default with a 1-line rationale and proceed. The user can rate the run \`bad\` afterward if your choice was wrong; that costs less than blocking the whole chain on a question. If in doubt: do not pause, decide.

### Readable connectors in this project
${connectorSection}

${fetchExamples ? `Example fetch_context payloads:\n\`\`\`\n${fetchExamples}\n\`\`\`\n` : ""}
**When to fetch_context:** the ticket references an external ID (JIRA-123, PR #42, a path on the server) but the body in the ticket is thin. ONE fetch per source per run is usually enough — don't loop. If a fetch fails, decide based on the error: missing creds = give_up with a concrete reason; bad params = retry with corrected params; otherwise proceed without it.

### Available sub-agents for dispatch:
${subagentList}

## Strategy rules

You are the routing brain — there is no separate Tech Lead. **You decide** whether the ticket needs planning, who codes it, what gates run, and when it's done. The skill registry above is your team; the rules below tell you when to reach for whom.

### How to size a ticket on the FIRST turn

Read the title + body + episodic memory. Pick ONE bucket:

- **Trivial** — single file, well-known pattern (new endpoint following an existing one, typo fix, small bugfix, dep bump). _Skip planning._ → \`dispatch\` Junior (Haiku) with concrete notes referencing the existing pattern.
- **Standard feature** — non-trivial business logic, multi-file but coherent (one component, no infra). _Skip planning if the spec is unambiguous._ → \`dispatch\` **Junior**. Multi-file does NOT mean Senior. Junior writes the bulk; Reviewer + Senior come in to check and fix after.
- **Design-needed** — touches multiple components, introduces a new pattern, has security or migration implications, > 1 day work. → \`run_playbook_phase architect\` first to produce plan.md, then **dispatch Junior per the plan**. Architect's plan turns Design-needed into "follow the plan" work that Junior can do.
- **Pure infra** — Dockerfile / docker-compose / nginx / php.ini / CI / deploy / .env / runtime config; ZERO app source files. → \`run_playbook_phase devops\` then \`run_playbook_phase devops_review\`. Skip the dev coders.
- **Cross-cutting** — needs BOTH infra changes AND app code. _Don't try to do both in one run._ → \`request_decompose\` immediately. CTO will produce a clean infra subticket + one or more code subtickets.

### Cost and escalation — Junior does 80%, Senior does 20%

The mental model: **Junior writes AND fixes most things**. Senior steps in only for genuinely hard cases. Target ratio: **80 % of dispatches are Junior, 20 % are Senior**. If a typical ticket burns more on Senior than Junior, you're calling Senior too often — re-read this section.

1. **Always start with Junior.** Code-writing, boilerplate, controllers, DTOs, services, repos, tests, migrations, fixtures, type wiring. "Tedious but mechanical" = Junior territory.

2. **Junior also fixes most CI / lint / static-analysis failures.** When ci_gate bounces on:
   - PHPStan / Psalm / mypy single-line errors (add type hint, remove dead guard, narrow union)
   - PHP-CS-Fixer / Prettier / ESLint formatting violations
   - Missing import / use statement
   - Renaming a method to match a base class
   - Test setup tweak (one fixture, one mock wiring)
   → dispatch **Junior again** with the exact failure tail as notes. Haiku is plenty competent at parsing a compiler error and fixing the line. Junior fixing 3 PHPStan errors in 3 attempts costs ~\$1; Senior doing the same costs ~\$5 for no quality gain.

3. **Senior only for these specific cases** (be honest — most failures don't qualify):
   - Junior was dispatched **3 times** on the SAME failure and the issue persists. The pattern is structural, not a code typo — Senior brings deeper understanding.
   - **Reviewer flagged design-level issues**: cross-cutting refactor, leaky abstraction, subtle logic bug Junior wouldn't spot, security regression. Quote Reviewer's specific finding when dispatching.
   - **Genuinely hard problem from the start**: subtle concurrency / race condition, algorithm design decision (which data structure / approach), debugging a heisenbug, multi-system coordination. State the SPECIFIC hardness in your rationale — "Senior because it's a multi-file change" does NOT qualify.
   - **Security primitives from scratch**: writing auth from zero, designing a permission model, threat-modeling an API surface. (Using existing auth middleware = Junior.)

4. **After Senior delivers a fix, dispatch Junior to apply remaining polish**, not Senior again. Senior touched the hard part; Junior can run the final ci_gate + fix any leftover lint without another expensive Senior turn.

5. **Same-skill cap**: each sub-agent ≤ 4 dispatches per run (code-enforced). After 3 cycles with no progress → \`request_decompose\` or \`give_up\`.

6. **Reflect every turn.** When you're about to dispatch Senior, ask: "Could Junior fix this with the failure notes as a hint?" If yes, dispatch Junior. Cheap iterations beat expensive one-shots.

### Closing a run

5. **ci_gate before mark_done — always.** Code-enforced: \`mark_done\` is rejected if no \`ci_gate\` succeeded earlier in this run. After fixes, re-run ci_gate.
5a. **git_push gate before mark_done — when configured.** If the workflow has a phase with task type \`git_push\`, code enforces that the **last git_push attempt must be ok=true** before \`mark_done\` is accepted. Push IS done — code that didn't reach the remote isn't delivered. Order in a typical run: Junior writes → Reviewer flags issues → Senior fixes → ci_gate green → \`run_playbook_phase git_push\` → mark_done. If git_push fails transiently (auto-retried internally already), Director may re-run it once; persistent failure → give_up with the concrete error.
6. **Reviewer is REQUIRED before mark_done unless the ticket is trivial.** Before \`mark_done\`, run through this checklist:
   - Did a Reviewer pass on the latest code? If no AND ticket is non-trivial → dispatch Reviewer first.
   - If Reviewer found issues, look at the SEVERITY: small/local fixes (rename, missing null check, copy edit, single-test addition) → **Junior** fixes with Reviewer's findings as notes. Only escalate to Senior if Reviewer flagged a **design-level** problem (see rule 3 above).
   - **Mandatory Reviewer triggers (no exceptions):** authentication / authorization, session handling, password / token / secret handling, payments or money movement, permission boundaries, data migration, schema change, deletion of user data, anything touching security headers / CSRF / CORS / SQL queries with user input.
   - **Trivial = Reviewer optional:** typo fix, copy / string change, single-line config tweak, dependency bump with no API change, rename within one file. When in doubt, run Reviewer — one extra turn is cheaper than a regression.
7. **Tester** runs automated tests separately from ci_gate; use it when ci_gate doesn't already exercise the test suite.

### Notes & dispatch quality

8. **Notes are CONCRETE.** "Add /version endpoint to api/ following HealthController pattern, smoke test required, no shell_exec" — NOT "do the ticket". Include file paths, function names, acceptance criteria, gotchas you noticed in episodic memory.
9. **One dispatch = one focused outcome.** Don't ask Junior to "implement and review and test" in one shot — that's three skills.

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
  if (a.action === "fetch_context") act = `fetch_context ${a.connector}: ${JSON.stringify(a.params).slice(0, 100)}`;
  if (a.action === "request_human_review") act = `request_human_review: ${a.question.slice(0, 100)}`;
  if (a.action === "dispatch_parallel") act = `dispatch_parallel [${a.targets.map((t) => t.subagent).join(", ")}]`;
  return `${act}  [${d.rationale.slice(0, 100)}]`;
}

function formatOutcome(o: Outcome): string {
  if (o.kind === "subagent") {
    const issues = o.issues.length > 0 ? ` issues: ${o.issues.slice(0, 3).map((i) => i.message ?? "").join(" / ")}` : "";
    return `[${o.subagent}] ok=${o.ok} commits=+${o.commits_added} cost=$${o.cost_usd.toFixed(2)}${issues}\n  summary: ${o.summary.slice(0, 200)}`;
  }
  if (o.kind === "ci_gate") {
    const label = o.task_type && o.task_type !== "shell" ? `${o.task_type} gate` : "ci_gate";
    const phase = o.phase_id ? ` [${o.phase_id}]` : "";
    // Show the LAST 2500 chars of the tail, not the first 300. CI output is
    // typically structured "noise (context, file scan) → ERROR SUMMARY at the
    // bottom"; truncating from the front cut off the actual error and left
    // Director staring at git diff noise (real bug from AGA-60 run ZEClJTg2ME).
    const tail = o.details_tail ? `\n  tail:\n${o.details_tail.slice(-2500)}` : "";
    return `${label}${phase} ok=${o.ok}\n  summary: ${o.summary.slice(0, 400)}${tail}`;
  }
  if (o.kind === "context_fetched") {
    if (!o.ok) return `fetch_context ${o.connector} FAILED: ${o.error ?? "(unknown)"}`;
    // Surface the full content so Director can quote it in the next dispatch.
    // Cap to 6 KB to bound prompt size; jira/github read methods already truncate at 4 KB body.
    return `fetch_context ${o.connector} OK:\n${o.content.slice(0, 6000)}`;
  }
  if (o.kind === "human_review") {
    return `human_review ${o.approved ? "APPROVED" : "REJECTED"}${o.note ? `\n  user: ${o.note.slice(0, 1500)}` : ""}`;
  }
  if (o.kind === "parallel_dispatch") {
    const lines = o.results.map((r) => {
      const issues = r.issues.length > 0 ? ` issues: ${r.issues.slice(0, 3).map((i) => i.message ?? "").join(" / ")}` : "";
      return `  - [${r.subagent}] ok=${r.ok} cost=$${r.cost_usd.toFixed(2)}${issues}\n    summary: ${r.summary.slice(0, 200)}`;
    });
    return `parallel_dispatch all_ok=${o.all_ok} total=$${o.total_cost_usd.toFixed(2)}\n${lines.join("\n")}`;
  }
  return `terminal ${o.status}: ${o.reason}`;
}

// ---- Sub-agent dispatch -----------------------------------------------------

function resolveAvailableSubagents(project: ProjectWithRepos, cfg: DirectorConfig): string[] {
  // Explicit override always wins.
  if (cfg.available_subagents && cfg.available_subagents.length > 0) {
    return cfg.available_subagents.filter((n) => project.agents.some((a) => a.name === n));
  }
  // Otherwise the workflow IS the contract: only agents referenced by a phase
  // (kind=agent, agent_id set) are dispatchable. Agents that exist in
  // project.agents but aren't wired into the workflow are intentional
  // off-the-shelf templates or internal-only roles (CTO via decompose,
  // Memory Curator via post-run hook) — Director should NOT surface them
  // as dispatch targets.
  const wiredAgentIds = new Set(
    (project.workflow.phases ?? [])
      .filter((p) => p.kind === "agent" && p.agent_id)
      .map((p) => p.agent_id as string),
  );
  const wired = project.agents
    .filter((a) => wiredAgentIds.has(a.id) && !SUBAGENT_BLACKLIST.has(a.name))
    .map((a) => a.name);
  // Safety fallback: if workflow has no agent phases yet (fresh project),
  // fall back to all non-blacklisted agents so the system isn't unusable
  // until the user wires up a workflow.
  if (wired.length === 0) {
    return project.agents
      .filter((a) => !SUBAGENT_BLACKLIST.has(a.name))
      .map((a) => a.name);
  }
  return wired;
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

/** Run multiple read-only sub-agents concurrently against the same worktree.
 *  Caller already passed enforceGuardrails so we can assume targets are
 *  reviewer-role and within caps. dispatchSubagent handles its own per-call
 *  events; we just await all and aggregate.
 *
 *  Race notes: dispatchSubagent updates `runs.agent_role` / `current_agent_name`
 *  as a side effect, which is fine when one runs at a time. With concurrent
 *  calls the row reflects whichever finished setting last — acceptable; the
 *  authoritative source for "what's running" is director_dispatch /
 *  director_subagent_done events, not the row. */
async function dispatchParallel(
  args: DirectorRunArgs,
  targets: Array<{ subagent: string; notes: string }>,
): Promise<ParallelDispatchOutcome> {
  args.emit("director_dispatch", {
    subagent: "parallel",
    targets: targets.map((t) => t.subagent),
  });
  const results = await Promise.all(
    targets.map((t) => dispatchSubagent(args, t.subagent, t.notes)),
  );
  const total_cost_usd = results.reduce((s, r) => s + r.cost_usd, 0);
  const all_ok = results.every((r) => r.ok === true);
  args.emit("director_subagent_done", {
    subagent: "parallel",
    ok: all_ok,
    cost_usd: total_cost_usd,
    summary: `${results.length} parallel: ${results.map((r) => `${r.subagent}=${r.ok ? "ok" : "fail"}`).join(", ")}`,
    parallel_results: results.map((r) => ({
      subagent: r.subagent,
      ok: r.ok,
      cost_usd: r.cost_usd,
      summary: r.summary,
      issues: r.issues,
    })),
  });
  return { kind: "parallel_dispatch", results, total_cost_usd, all_ok };
}

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
  if (kind === "task" && phase.task) {
    // Generic task gate (git_push and similar): run via the task registry,
    // surface the verdict as a ci-gate-style outcome so Director sees ok/fail
    // and can react on the next turn. Tagging the outcome with the phase_id
    // lets enforceGuardrails check specific gates (e.g. git_push must be
    // green before mark_done).
    return runTaskGate(args, phase.id, phase.task.type, phase.task.config as Record<string, unknown>);
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

// ---- fetch_context dispatch -------------------------------------------------

/** Connector summary for the system prompt: which connectors does the project
 *  have configured (via workflow phases) that also support read()?
 *  We only advertise readable ones — Director can't fetch from telegram, etc. */
function describeReadableConnectors(project: ProjectWithRepos): { type: string; hint: string }[] {
  const phases = project.workflow.phases ?? [];
  const seen = new Map<string, { type: string; hint: string }>();
  for (const p of phases) {
    if (p.kind !== "task" || !p.task) continue;
    const t = p.task.type;
    if (t !== "jira" && t !== "github" && t !== "ssh") continue;
    if (seen.has(t)) continue;
    let hint = "";
    if (t === "github") {
      const cfg = p.task.config as { default_repo?: string };
      hint = cfg.default_repo ? `default repo: ${cfg.default_repo}` : "";
    } else if (t === "ssh") {
      const cfg = p.task.config as { host?: string };
      hint = cfg.host ? `host: ${cfg.host}` : "";
    }
    seen.set(t, { type: t, hint });
  }
  return [...seen.values()];
}

async function fetchContext(
  args: DirectorRunArgs,
  action: FetchContextAction,
): Promise<ContextFetchedOutcome> {
  args.emit("director_dispatch", {
    subagent: `fetch_context:${action.connector}`,
    params: action.params,
  });
  const r = await readTask(action.connector, args.project, action.params);
  args.emit("director_context_fetched", {
    connector: action.connector,
    ok: r.ok,
    content: r.content,
    error: r.error,
  });
  return { kind: "context_fetched", connector: action.connector, ok: r.ok, content: r.content, error: r.error };
}

// ---- ci_gate dispatch -------------------------------------------------------

/** Run an arbitrary task (git_push, custom connector) as a Director-visible
 *  gate. Verdict shows up as CiGateOutcome tagged with phase_id + task_type
 *  so enforceGuardrails can require specific gates green before mark_done. */
async function runTaskGate(
  args: DirectorRunArgs,
  phaseId: string,
  taskType: string,
  taskConfig: Record<string, unknown>,
): Promise<CiGateOutcome> {
  args.emit("director_dispatch", { subagent: `task:${phaseId}`, task_type: taskType });
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
  const verdict = await runTask(taskType, taskConfig, taskCtx);
  const summary = String(verdict.summary ?? "").slice(0, 400);
  const tail = String((verdict as { details?: string }).details ?? "").slice(-4000);
  args.emit("director_subagent_done", {
    subagent: `task:${phaseId}`,
    task_type: taskType,
    phase_id: phaseId,
    ok: verdict.ok,
    summary,
  });
  return { kind: "ci_gate", ok: !!verdict.ok, summary, details_tail: tail, phase_id: phaseId, task_type: taskType };
}

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
  const tail = String((verdict as { details?: string }).details ?? "").slice(-4000);

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
