/**
 * Director-pattern orchestration — top-level agent that dispatches sub-agents
 * via native Anthropic Messages API tool use, with persistent conversation
 * state and prompt caching.
 *
 * Design notes (vs the previous JSON-parsing approach):
 *   - Uses `@anthropic-ai/sdk` Messages API directly (not claude CLI), so
 *     we get native `tool_use` blocks instead of having to parse JSON from
 *     prose.
 *   - Conversation state (messages[]) is persistent across turns: each
 *     decision sees the full context of every prior dispatch + result.
 *   - System prompt is cached (`cache_control: ephemeral`), so repeated
 *     turns within one Director session pay only the input delta.
 *   - Sub-agent dispatches still use the existing `runAgent` machinery
 *     (claude CLI) for isolation.
 *   - Streaming: token deltas forwarded via SSE so RunView shows live
 *     Director thinking.
 *
 * Requires: ANTHROPIC_API_KEY in env (or pass `apiKey` via DirectorConfig).
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
  ToolUseBlock,
  TextBlock,
  ContentBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ProjectWithRepos,
  Ticket,
  WorkflowPhase,
  ReviewVerdict,
} from "@ceo/shared";
import { runAgent, specFromAgent } from "./agents.js";
import type { AgentContext } from "./agents.js";
import { loadAgent } from "./store.js";
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
  /** Override model. Default: claude-sonnet-4-6 */
  model?: string;
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

// ---- Constants --------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_BUDGET_USD = 8;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const SUBAGENT_BLACKLIST = new Set(["CTO", "Memory Curator", "Director"]);

// ---- Tool schemas (native Messages API tool_use) ----------------------------

function buildTools(subagents: string[]): Tool[] {
  return [
    {
      name: "dispatch_subagent",
      description:
        "Dispatch a sub-agent to do work. Sub-agents are real Claude calls in isolated subprocesses — they read/write files in the worktree, commit, and return a verdict. Use this for code writing, code review, and verification.",
      input_schema: {
        type: "object" as const,
        properties: {
          subagent: {
            type: "string" as const,
            enum: subagents,
            description: "Which sub-agent to dispatch.",
          },
          notes: {
            type: "string" as const,
            description:
              "Concrete instructions for this dispatch. Be specific: 'Add /version endpoint to api/ following HealthController pattern, smoke test required.' NOT 'do the ticket'.",
          },
        },
        required: ["subagent", "notes"],
      },
    },
    {
      name: "run_ci_gate",
      description:
        "Run the project's CI command (composer ci / npm test / make ci) inside Docker. Returns pass/fail + tail of stdout/stderr. Always run before mark_done. If it fails twice for the same root cause, give_up — don't loop.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "request_decompose",
      description:
        "Hand the ticket to CTO for splitting into subtickets. Use when the ticket spans unrelated concerns (e.g. infra + code + docs as independent threads). CTO creates subtickets and ends this run cleanly.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string" as const,
            description: "1-2 sentences why decomposition produces cleaner outcomes than tackling as-one.",
          },
        },
        required: ["reason"],
      },
    },
    {
      name: "mark_done",
      description:
        "All acceptance criteria are met. Run ends as succeeded. Always call run_ci_gate first.",
      input_schema: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string" as const,
            description: "2-3 sentences: what was delivered, key changes.",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "give_up",
      description:
        "You are stuck. Run ends as failed. Use sparingly — only when you've genuinely run out of approaches OR a sub-agent surfaced a blocker that needs human intervention.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string" as const,
            description: "Concrete blocker. The human will read this.",
          },
        },
        required: ["reason"],
      },
    },
  ];
}

// ---- Director system prompt ------------------------------------------------

function buildDirectorSystemPrompt(subagents: string[], cfg: DirectorConfig, project: ProjectWithRepos, ticket: Ticket, worktrees: { repo_name: string; path: string }[]): string {
  const subagentList = subagents.length === 0
    ? "(none configured — only request_decompose / give_up are useful)"
    : subagents.map((s) => `  - ${s}`).join("\n");

  return `You are the Director — the lead orchestrator on this project. You delegate work to sub-agents using the available tools; you do NOT write code or modify files yourself.

Reflect first, then act. Each turn, look at the recent tool results and decide ONE next action by calling the appropriate tool.

## Project: ${project.name}

${project.description || "(no description)"}

${cfg.project_brief ? `### Project brief\n${cfg.project_brief}\n` : ""}

## Available sub-agents

${subagentList}

## Repos in this run

${worktrees.map((w) => `- ${w.repo_name} (${w.path})`).join("\n")}

## Strategy

1. **Start cheap.** Junior (Haiku) does bulk work. Reach for Senior (Opus) only after Junior bounces twice or Reviewer surfaces architecture issues.
2. **Reflect.** Each turn, look at the last tool result. Don't repeat what just failed identically — change tactics.
3. **Hard limits.** Don't dispatch the same sub-agent more than 4 times in one run. After 3 cycles without progress, request_decompose or give_up.
4. **Always run_ci_gate before mark_done.** If ci_gate fails twice for the same root cause, give_up — don't loop forever.
5. **Notes are CONCRETE.** Each dispatch's notes give the sub-agent enough to act: file paths, patterns to follow, acceptance criteria. NOT "do the ticket".
6. **Be terse in your reasoning.** Briefly explain your decision in plain text BEFORE calling a tool. The team reads your thoughts; don't waste their time.

## Ticket

**${ticket.ticket_key ?? ticket.id}** — ${ticket.title}

${ticket.body || "(no body)"}
${ticket.triage_notes ? `\n### Triage notes\n${ticket.triage_notes}` : ""}`;
}

// ---- Main entry -------------------------------------------------------------

export async function runDirectorPhase(args: DirectorRunArgs): Promise<DirectorResult> {
  const cfg = (args.phase.director ?? {}) as DirectorConfig;
  const maxIter = cfg.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const budget = cfg.budget_usd ?? DEFAULT_BUDGET_USD;
  const model = cfg.model ?? DEFAULT_MODEL;

  if (!process.env.ANTHROPIC_API_KEY) {
    args.emit("director_end", {
      reason: "no_api_key",
      total_cost_usd: 0,
      iterations: 0,
    });
    return {
      ok: false,
      summary:
        "ANTHROPIC_API_KEY not set. Director uses the Anthropic Messages API directly (separate from claude CLI subprocess auth). Get a key from console.anthropic.com → Settings → API Keys, set ANTHROPIC_API_KEY in env, restart server.",
      iterations: 0,
      total_cost_usd: 0,
    };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const subagents = resolveAvailableSubagents(args.project, cfg);

  args.emit("director_start", {
    max_iterations: maxIter,
    budget_usd: budget,
    available_subagents: subagents,
    project_brief: cfg.project_brief ?? null,
    model,
  });

  const tools = buildTools(subagents);
  const systemPrompt = buildDirectorSystemPrompt(subagents, cfg, args.project, args.ticket, args.worktrees);

  // Persistent conversation state. We keep it growing across turns so the
  // Director sees full history natively. System prompt has cache_control so
  // repeat input cost is minimal.
  const messages: MessageParam[] = [];
  // Seed with an initial user turn instructing the Director to start.
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `# Initial context

## Repos in this run
${args.worktrees.map((w) => `- ${w.repo_name} at ${w.path}`).join("\n")}

## Budget
- max iterations: ${maxIter}
- budget: $${budget.toFixed(2)}

Start by reflecting on what's needed and deciding the first action. Call one tool to begin.`,
      },
    ],
  });

  let totalCost = 0;
  let iter = 0;

  while (iter < maxIter) {
    iter++;

    if (totalCost >= budget) {
      args.emit("director_end", { reason: "budget_exhausted", total_cost_usd: totalCost, iterations: iter });
      return {
        ok: false,
        summary: `Budget $${budget} exhausted at $${totalCost.toFixed(2)}`,
        iterations: iter,
        total_cost_usd: totalCost,
      };
    }

    // ---- Call Director (one Messages API turn with streaming) ----
    let response: Message;
    try {
      response = await callDirectorTurn({
        client,
        model,
        system: systemPrompt,
        messages,
        tools,
        emit: args.emit,
        registerCancel: args.registerCancel,
        unregisterCancel: args.unregisterCancel,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      args.emit("system", { msg: `Director API call failed: ${msg}` });
      return { ok: false, summary: `Director crashed: ${msg}`, iterations: iter, total_cost_usd: totalCost };
    }

    // Cost accounting from the response usage.
    const turnCost = estimateMessageCost(response, model);
    totalCost += turnCost;

    // Surface Director's reasoning text (the prose between tool calls).
    const directorThinking = textBlocks(response.content);

    // Find the tool_use block (Director picks ONE per turn typically; if
    // multiple, we run them in sequence and feed all results back).
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    args.emit("director_decision", {
      iteration: iter,
      rationale: directorThinking,
      action: toolUses.length > 0
        ? { action: toolUses[0]!.name, ...(toolUses[0]!.input as Record<string, unknown>) }
        : { action: "no_tool_called" },
      cost_usd: turnCost,
      total_cost_usd: totalCost,
      stop_reason: response.stop_reason,
    });

    // Persist Director's message into conversation history.
    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      // Director ended without calling a tool. Treat as give_up.
      args.emit("director_end", { reason: "no_tool_called", total_cost_usd: totalCost, iterations: iter });
      return {
        ok: false,
        summary: directorThinking || "Director stopped without calling any tool",
        iterations: iter,
        total_cost_usd: totalCost,
      };
    }

    // ---- Execute tool calls and produce tool_result blocks ----
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];
    let terminal: DirectorResult | null = null;

    for (const tu of toolUses) {
      // Terminal tools — emit and break out of the run.
      if (tu.name === "mark_done") {
        const summary = (tu.input as { summary?: string }).summary ?? "";
        args.emit("director_end", { reason: "mark_done", iterations: iter, total_cost_usd: totalCost });
        terminal = { ok: true, summary, iterations: iter, total_cost_usd: totalCost };
        break;
      }
      if (tu.name === "give_up") {
        const reason = (tu.input as { reason?: string }).reason ?? "no reason given";
        args.emit("director_end", { reason: "give_up", iterations: iter, total_cost_usd: totalCost });
        terminal = { ok: false, summary: reason, iterations: iter, total_cost_usd: totalCost };
        break;
      }
      if (tu.name === "request_decompose") {
        const reason = (tu.input as { reason?: string }).reason ?? "";
        try {
          const result = await decomposeTicket(args.project, args.ticket);
          args.emit("director_end", {
            reason: "decompose_requested",
            decomposed: result.decomposed,
            subticket_count: result.created.length,
            iterations: iter,
            total_cost_usd: totalCost,
          });
          terminal = {
            ok: result.decomposed,
            summary: result.decomposed
              ? `Decomposed into ${result.created.length} subticket(s). Reason: ${reason}. CTO rationale: ${result.rationale}`
              : `CTO declined to decompose: ${result.rationale}`,
            iterations: iter,
            total_cost_usd: totalCost,
            decomposed: result.decomposed ? { subticket_count: result.created.length } : undefined,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          terminal = { ok: false, summary: `decompose failed: ${msg}`, iterations: iter, total_cost_usd: totalCost };
        }
        break;
      }

      // Non-terminal tools — execute and push result.
      if (tu.name === "dispatch_subagent") {
        const input = tu.input as { subagent: string; notes: string };
        const outcome = await dispatchSubagent(args, input.subagent, input.notes);
        totalCost += outcome.cost_usd;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: formatSubagentResult(outcome),
        });
        continue;
      }
      if (tu.name === "run_ci_gate") {
        const outcome = await runCiGate(args, cfg);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: formatCiGateResult(outcome),
        });
        continue;
      }

      // Unknown tool name — should not happen but be safe.
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: `Unknown tool "${tu.name}". This is a runtime bug; ignore and try a different action.`,
        is_error: true,
      });
    }

    if (terminal) {
      return terminal;
    }

    // Push tool results back into the conversation for the next turn.
    messages.push({ role: "user", content: toolResults });

    // Refresh budget warning if approaching limit.
    if (totalCost > budget * 0.8) {
      args.emit("system", {
        msg: `Director approaching budget: $${totalCost.toFixed(2)} / $${budget.toFixed(2)}. Hard cap at 100%.`,
      });
    }
  }

  args.emit("director_end", { reason: "max_iterations", iterations: iter, total_cost_usd: totalCost });
  return {
    ok: false,
    summary: `Max iterations (${maxIter}) reached without mark_done`,
    iterations: iter,
    total_cost_usd: totalCost,
  };
}

// ---- Director Messages API call (streaming) ---------------------------------

interface DirectorTurnArgs {
  client: Anthropic;
  model: string;
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  emit: (event: string, payload: Record<string, unknown>) => void;
  registerCancel: (cancel: () => void) => void;
  unregisterCancel: () => void;
}

async function callDirectorTurn(args: DirectorTurnArgs): Promise<Message> {
  // Stream so we can surface tokens live to the SSE feed. The SDK collects
  // them into a final Message at the end.
  const stream = args.client.messages.stream({
    model: args.model,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: args.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: args.tools,
    messages: args.messages,
  });

  // Allow user-triggered cancel.
  args.registerCancel(() => {
    try {
      stream.controller.abort();
    } catch {
      /* ignore */
    }
  });

  // Forward token deltas as SSE events for live UI.
  let textBuffer = "";
  stream.on("text", (chunk) => {
    textBuffer += chunk;
    args.emit("director_thinking", { text_delta: chunk });
  });
  stream.on("error", (err) => {
    args.emit("system", { msg: `Director stream error: ${err.message}` });
  });

  const final = await stream.finalMessage();
  args.unregisterCancel();
  return final;
}

// ---- Helpers ----------------------------------------------------------------

function textBlocks(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Conservative cost estimate from message.usage (sonnet-4-6 default rates). */
function estimateMessageCost(msg: Message, model: string): number {
  const usage = msg.usage;
  if (!usage) return 0;
  // Rates per 1M tokens. Update if model changes.
  const rates = pricePer1m(model);
  const inputTokens = usage.input_tokens ?? 0;
  const cacheReadTokens = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheWriteTokens = (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return (
    (inputTokens / 1_000_000) * rates.input +
    (cacheReadTokens / 1_000_000) * rates.cacheRead +
    (cacheWriteTokens / 1_000_000) * rates.cacheWrite +
    (outputTokens / 1_000_000) * rates.output
  );
}

function pricePer1m(model: string): { input: number; cacheRead: number; cacheWrite: number; output: number } {
  // Defaults: claude-sonnet-4-6 pricing (USD per 1M tokens, as of 2026-04).
  // Cache write is 1.25x input; cache read is 0.1x input.
  if (model.includes("opus")) {
    return { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 };
  }
  if (model.includes("haiku")) {
    return { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };
  }
  // Sonnet default
  return { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 };
}

function formatSubagentResult(o: SubagentOutcome): string {
  const issues = o.issues.length > 0
    ? `\nIssues:\n${o.issues.slice(0, 5).map((i) => `- [${i.severity ?? "?"}] ${i.message ?? ""}`).join("\n")}`
    : "";
  return `Sub-agent ${o.subagent} returned:
- ok: ${o.ok}
- commits added: +${o.commits_added}
- cost: $${o.cost_usd.toFixed(3)}
- summary: ${o.summary}${issues}`;
}

function formatCiGateResult(o: CiGateOutcome): string {
  return `ci_gate result:
- ok: ${o.ok}
- summary: ${o.summary}
- tail (last 2KB):
${o.details_tail.slice(-2000)}`;
}

// ---- Sub-agent dispatch (reuses existing runAgent infrastructure) -----------

interface SubagentOutcome {
  subagent: string;
  ok: boolean | null;
  summary: string;
  issues: { severity?: string; message?: string }[];
  commits_added: number;
  cost_usd: number;
}

interface CiGateOutcome {
  ok: boolean;
  summary: string;
  details_tail: string;
}

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
    pipelineContext: `You are working under a Director who will read your verdict and decide next steps. Make focused, scoped changes per the notes above.`,
    recentRuns: null,
  };

  let cost = 0;
  const handlers = {
    onLine: (line: string) => {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === "result" && typeof ev.total_cost_usd === "number") {
          cost = ev.total_cost_usd;
        }
        args.emit("claude_stream", ev);
      } catch {
        /* not JSON */
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
    subagent: subagentName,
    ok,
    summary,
    issues,
    commits_added: commitsAdded,
    cost_usd: cost,
  };
}

// ---- ci_gate dispatch (reuses existing shell task infrastructure) -----------

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
      ok: false,
      summary: "no ci_gate_command on director and no ci_gate phase in project workflow",
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
