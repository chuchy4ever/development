import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import type { ProjectWithRepos, Run, RunEventType, Ticket } from "@ceo/shared";
import { db, nowIso } from "./db.js";
import { PROJECTS_DIR } from "./config.js";
import {
  diffWorktree,
  ensureWorktree,
  getRemoteUrl,
  pushBranch,
  removeWorktree,
  tryFastForwardParent,
} from "./git.js";
import { loadAgent, loadProject, loadProjectWithRepos, loadRun, loadTicket, todaysCostForProject } from "./store.js";
import { runAgent, specFromAgent } from "./agents.js";
import { AGENT_NAMES } from "./defaultAgents.js";
import type { AgentContext } from "./agents.js";
import type { ReviewVerdict, TestVerdict, WorkflowDefinition, WorkflowPhase } from "@ceo/shared";
import { buildRunClaudeMd, writeRunClaudeMd } from "./runClaudeMd.js";
import { applyMemoryUpdate, readAgentMemory } from "./agentMemory.js";
import { applyProjectMemoryUpdate } from "./projectMemory.js";
import { runAgentOneShot } from "./oneShot.js";
import { extractCostFromStdout, recordCost } from "./costLog.js";
import { extractJsonWithFallback } from "./jsonUtil.js";
import { runTask, CONNECTOR_TASK_TYPES } from "./tasks/index.js";
import { normalizePhase } from "@ceo/shared";

/** Per-run event emitter. SSE handlers subscribe; engine emits. */
class RunBus extends EventEmitter {}
const buses = new Map<string, RunBus>();
/** Cancel handles for currently-running claude processes. */
const cancelHandles = new Map<string, () => void>();
function busFor(runId: string): RunBus {
  let b = buses.get(runId);
  if (!b) {
    b = new RunBus();
    b.setMaxListeners(50);
    buses.set(runId, b);
  }
  return b;
}

export function subscribeRun(runId: string, fn: (ev: PersistedEvent) => void): () => void {
  const bus = busFor(runId);
  bus.on("event", fn);
  return () => bus.off("event", fn);
}

export interface PersistedEvent {
  id: number;
  run_id: string;
  ts: string;
  type: RunEventType;
  payload: any;
}

function emit(runId: string, type: RunEventType, payload: any) {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO run_events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)`,
    )
    .run(runId, ts, type, JSON.stringify(payload));
  const ev: PersistedEvent = {
    id: info.lastInsertRowid as number,
    run_id: runId,
    ts,
    type,
    payload,
  };
  const bus = busFor(runId);
  bus.emit("event", ev);
  // After "done", drop the bus on next tick so any late SSE clients fall back
  // to listEvents() for replay. Subscribers already received the done event.
  if (type === "done") {
    setImmediate(() => {
      bus.removeAllListeners();
      buses.delete(runId);
    });
  }
}

export function listEvents(runId: string, sinceId = 0): PersistedEvent[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, ts, type, payload FROM run_events
       WHERE run_id = ? AND id > ?
       ORDER BY id ASC`,
    )
    .all(runId, sinceId) as any[];
  return rows.map((r) => ({
    id: r.id,
    run_id: r.run_id,
    ts: r.ts,
    type: r.type,
    payload: safeParse(r.payload),
  }));
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

export interface StartRunInput {
  project: ProjectWithRepos;
  ticket: Ticket;
}

export async function startRun({ project, ticket }: StartRunInput): Promise<string> {
  if (project.repos.length === 0) {
    throw new Error("project has no repos configured");
  }

  // Determine target repos: use ticket.repos_touched if set, otherwise all repos.
  const targetRepos = ticket.repos_touched.length > 0
    ? project.repos.filter((r) => ticket.repos_touched.includes(r.name))
    : project.repos;

  if (targetRepos.length === 0) {
    throw new Error("no matching repos for this ticket");
  }

  // Preflight: a run needs at least one dispatchable coder. Without one
  // Director can only spin until give_up — better to fail fast with a
  // pointing-at-the-problem error than burn iterations on a doomed run.
  // Mirrors resolveAvailableSubagents: an agent is dispatchable when it's
  // referenced by a workflow phase (kind=agent, agent_id set); if no phases
  // reference agents, fall back to all project agents (fresh-project safety).
  const phases = project.workflow?.phases ?? [];
  const wiredAgentIds = new Set(
    phases.filter((p) => p.kind === "agent" && p.agent_id).map((p) => p.agent_id as string),
  );
  const dispatchable = wiredAgentIds.size > 0
    ? project.agents.filter((a) => wiredAgentIds.has(a.id))
    : project.agents;
  const coders = dispatchable.filter((a) => a.role === "coder");
  if (coders.length === 0) {
    const totalAgents = project.agents.length;
    if (totalAgents === 0) {
      throw new Error(
        "Projekt nemá žádné agenty. Přidej alespoň jednoho codera (např. PHP Junior Coder z knihovny šablon) a propoj ho do workflow.",
      );
    }
    if (wiredAgentIds.size === 0) {
      throw new Error(
        `Workflow je prázdné (žádné agent phases). Projekt má ${totalAgents} agentů, ale žádný není propojený do workflow — otevři Workflow Editor a přidej phases.`,
      );
    }
    throw new Error(
      "Workflow nemá žádného coder agenta (role=coder). Přidej do workflow alespoň jednoho codera (Junior/Senior PHP, Drupal Junior/Senior, ...) — Reviewer a Tester sami nepostaví diff.",
    );
  }

  const runId = nanoid(10);
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task";
  const branch = `ceo/${slug}-${runId}`;

  // Plan worktree paths.
  const runRoot = path.join(PROJECTS_DIR, project.id, "runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const worktrees = targetRepos.map((r) => ({
    repo_name: r.name,
    repo_path: r.local_path,
    base_branch: r.default_branch,
    path: path.join(runRoot, r.name),
  }));

  const now = nowIso();
  db.prepare(
    `INSERT INTO runs
       (id, project_id, ticket_id, branch, status, agent_role, worktrees, created_at)
     VALUES (?, ?, ?, ?, 'pending', 'coder', ?, ?)`,
  ).run(
    runId,
    project.id,
    ticket.id,
    branch,
    JSON.stringify(worktrees.map((w) => ({ repo_name: w.repo_name, path: w.path }))),
    now,
  );

  // Mark ticket as running.
  db.prepare(`UPDATE tickets SET status = 'running', updated_at = ? WHERE id = ?`)
    .run(now, ticket.id);

  // Kick off async (do not await — caller gets the runId immediately).
  void executeRun({ runId, ticket, project, worktrees, branch });

  return runId;
}

interface ResumeState {
  attemptsByPhase?: Map<string, number>;
  reviewerFeedback?: string;
  /** Phase to re-enter at. If the workflow no longer contains this id, the
   *  resume aborts loudly rather than silently restarting from phases[0]. */
  startPhaseId: string | null;
}

async function executeRun(args: {
  runId: string;
  ticket: Ticket;
  project: ProjectWithRepos;
  worktrees: { repo_name: string; repo_path: string; base_branch: string; path: string }[];
  branch: string;
  resume?: ResumeState;
}) {
  const { runId, ticket, project, worktrees, branch, resume } = args;

  try {
    db.prepare(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(nowIso(), runId);

    if (!resume) {
      emit(runId, "system", {
        msg: `Run started for ticket "${ticket.title}"`,
        branch,
        repos: worktrees.map((w) => w.repo_name),
      });
    }

    // 1. Create worktrees in parallel.
    emit(runId, "system", {
      msg: `Creating ${worktrees.length} worktree(s)...`,
      repos: worktrees.map((w) => w.repo_name),
    });
    await Promise.all(
      worktrees.map(async (wt) => {
        await ensureWorktree(wt.repo_path, wt.path, branch, wt.base_branch);
        emit(runId, "system", { msg: `Worktree ready: ${wt.repo_name}` });
      }),
    );

    // The cwd is the run root, so claude can read across all repos in this run.
    const cwd = path.dirname(worktrees[0]!.path);

    // Write CLAUDE.md at run root: project context + memory + workflow specifics.
    // Claude CLI auto-loads it, so we drop these blocks from per-call prompts.
    writeRunClaudeMd(cwd, buildRunClaudeMd({
      project,
      projectSpecifics: project.workflow.project_specifics ?? null,
    }));
    emit(runId, "system", { msg: "CLAUDE.md written to run root with project context + memory" });

    // Episodic memory: last few succeeded runs in this project (excluding this
    // one). Keeps agents aware of what was recently done so they don't
    // duplicate or contradict prior work.
    const recentRuns = buildRecentRunsContext(project.id, runId);

    const baseCtx: AgentContext = {
      project,
      ticket,
      worktrees: worktrees.map((w) => ({ repo_name: w.repo_name, path: w.path })),
      cwd,
      recentRuns,
    };

    const computeDiffs = async (): Promise<string> => {
      const parts: string[] = [];
      await Promise.all(
        worktrees.map(async (wt) => {
          try {
            const d = await diffWorktree(wt.path, wt.base_branch);
            emit(runId, "diff", { repo_name: wt.repo_name, diff: d });
            if (d.trim()) parts.push(`# ${wt.repo_name}\n${d}`);
          } catch (e: any) {
            emit(runId, "system", { msg: `diff failed for ${wt.repo_name}: ${e.message}` });
          }
        }),
      );
      return parts.join("\n\n");
    };

    const wasCancelledNow = (): boolean => {
      const row = db
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(runId) as { status: string } | undefined;
      return row?.status === "cancelled";
    };

    let totalCostUsd = 0;
    const phaseStreamHandlers = {
      onLine: (line: string) => {
        let parsed: any = line;
        try { parsed = JSON.parse(line); } catch {}
        // Accumulate cost from claude's result events.
        if (parsed && parsed.type === "result") {
          const cost = Number(parsed.total_cost_usd ?? parsed.cost_usd ?? NaN);
          if (Number.isFinite(cost)) {
            totalCostUsd += cost;
            db.prepare(`UPDATE runs SET total_cost_usd = ? WHERE id = ?`)
              .run(totalCostUsd, runId);
          }
        }
        emit(runId, "claude_stream", parsed);
      },
      onStderr: (chunk: string) => emit(runId, "stderr", chunk),
    };

    // ---- Walk the project's workflow definition --------------------------------
    // Director is the implicit orchestrator: every run starts with a synthesized
    // Director phase that uses the user's workflow.phases as a playbook. The user
    // designs the graph normally; Director runs above it. If the workflow already
    // contains an explicit director phase (legacy), we use it as-is.
    const workflow: WorkflowDefinition = project.workflow;
    const phases = workflow.phases;
    const phaseById = new Map(phases.map((p) => [p.id, p]));
    const IMPLICIT_DIRECTOR_ID = "__director__";
    const hasExplicitDirector = phases.some((p) => p.kind === "director");
    const implicitDirector: WorkflowPhase | null = hasExplicitDirector ? null : {
      id: IMPLICIT_DIRECTOR_ID,
      kind: "director",
      // Director config comes from the workflow (project-level settings).
      director: workflow.director_config ?? undefined,
    };
    const attemptsByPhase = resume?.attemptsByPhase
      ? new Map<string, number>(resume.attemptsByPhase)
      : new Map<string, number>();
    const MAX_STEPS = 50;
    let steps = 0;

    let lastVerdict: ReviewVerdict | TestVerdict | null = null;
    let lastFailedVerdict: ReviewVerdict | TestVerdict | null = null;
    let lastExitCode = 0;
    let reviewerFeedback: string | undefined = resume?.reviewerFeedback;
    let diffs = "";

    let phase: typeof phases[number] | undefined;
    if (resume?.startPhaseId) {
      // Resuming: lookup explicit phase, fall back to the implicit Director if
      // the previous run was driven by it (since the implicit Director is
      // stateless and re-synthesized fresh, restart it from scratch). Match
      // both the friendly "director" display id and the internal sentinel.
      if ((resume.startPhaseId === IMPLICIT_DIRECTOR_ID || resume.startPhaseId === "director") && implicitDirector) {
        phase = implicitDirector;
      } else {
        phase = phases.find((p) => p.id === resume.startPhaseId);
      }
      if (!phase) {
        emit(runId, "system", {
          msg: `Resume aborted: phase "${resume.startPhaseId}" no longer exists in workflow (workflow was edited?). Re-run the ticket to start fresh.`,
        });
        markFailed(runId, ticket.id, `resume: phase "${resume.startPhaseId}" missing`);
        return;
      }
    } else {
      // Director runs over every workflow as the implicit orchestrator. If the
      // workflow has an explicit director phase, the engine still walks normally
      // and the explicit one will be executed when reached.
      phase = implicitDirector ?? phases[0];
    }

    // On resume, recompute diffs so downstream phases (Senior, Reviewer, Tester,
    // Closer) see the work that was committed before the restart.
    if (resume) {
      diffs = await computeDiffs();
    }
    if (!phase) {
      emit(runId, "system", { msg: "Workflow has no phases — nothing to do." });
    }
    while (phase) {
      if (wasCancelledNow()) break;

      // Cost cap check: if today's spend on this project (across all runs)
      // exceeds the project's daily cap, abort the run.
      if (typeof project.daily_cost_cap_usd === "number" && project.daily_cost_cap_usd > 0) {
        const today = todaysCostForProject(project.id);
        if (today >= project.daily_cost_cap_usd) {
          emit(runId, "system", {
            msg: `Daily cost cap reached for project (today: $${today.toFixed(4)} ≥ cap: $${project.daily_cost_cap_usd.toFixed(4)}) — aborting run.`,
          });
          lastExitCode = 1;
          break;
        }
      }

      if (steps++ > MAX_STEPS) {
        emit(runId, "system", { msg: `Aborting — workflow exceeded ${MAX_STEPS} steps (cycle?).` });
        lastExitCode = 1;
        break;
      }
      const attempt = (attemptsByPhase.get(phase.id) ?? 0) + 1;
      attemptsByPhase.set(phase.id, attempt);

      // ----- Director phase: top-level Claude agent dispatching sub-agents -----
      // Director is a TERMINAL phase — it handles its own iteration internally
      // and either decides mark_done / give_up / decompose, or hits its budget.
      if (phase.kind === "director") {
        emit(runId, "phase_start", { role: "director", phase_id: phase.id, attempt });
        // Display "director" instead of the synthetic "__director__" id in the
        // run record — the user shouldn't see internal sentinels.
        const displayPhaseId = phase.id === IMPLICIT_DIRECTOR_ID ? "director" : phase.id;
        db.prepare(
          `UPDATE runs SET agent_role = ?, current_agent_name = ?, current_phase_id = ? WHERE id = ?`,
        ).run("director", "director", displayPhaseId, runId);

        const { runDirectorPhase } = await import("./director.js");
        const result = await runDirectorPhase({
          runId,
          project,
          ticket,
          phase,
          worktrees,
          cwd,
          recentRuns,
          emit: (event, payload) => emit(runId, event as RunEventType, payload),
          registerCancel: (c) => cancelHandles.set(runId, c),
          unregisterCancel: () => cancelHandles.delete(runId),
        });

        lastVerdict = {
          ok: result.ok,
          summary: result.summary,
          issues: [],
        } as unknown as ReviewVerdict;
        lastExitCode = result.ok ? 0 : 1;
        // Director aggregates its own sub-agent costs internally; merge into the run total.
        if (result.total_cost_usd > 0) {
          totalCostUsd += result.total_cost_usd;
          db.prepare(`UPDATE runs SET total_cost_usd = ? WHERE id = ?`)
            .run(totalCostUsd, runId);
        }
        // Pause-instead-of-fail: Director hit its budget but has more work to
        // do. Set the run to awaiting_approval so the user can extend budget
        // (approve) or cancel (reject) via decideApproval. We DON'T emit
        // phase_end — the phase isn't ending, it's being suspended.
        if (result.paused) {
          const pauseReason = result.paused.reason;
          let message: string;
          if (pauseReason === "budget_exhausted") {
            message = `Director paused: budget $${result.paused.budget_usd.toFixed(2)} exhausted at $${result.total_cost_usd.toFixed(2)}. Approve to extend budget by ~50% and resume; reject to cancel the run.`;
          } else if (pauseReason === "max_iterations") {
            message = `Director hit ${result.paused.max_iterations}-iteration limit after ${result.paused.iterations} turns. Typical cause: a long fix loop early in the run leaves no headroom for git_push + mark_done. Approve to extend by +10 iterations and let Director finish; reject to cancel.`;
          } else {
            message = `Director needs your input: ${result.paused.question}\n\n(${result.paused.rationale})`;
          }
          emit(runId, "awaiting_approval", {
            phase_id: displayPhaseId,
            pause_reason: pauseReason,
            message,
            ...(pauseReason === "human_review" ? { question: result.paused.question, rationale: result.paused.rationale } : {}),
          });
          db.prepare(
            `UPDATE runs SET status = 'awaiting_approval', current_phase_id = ?, pause_reason = ? WHERE id = ?`,
          ).run(displayPhaseId, pauseReason, runId);
          return; // exit cleanly — decideApproval restarts.
        }

        emit(runId, "phase_end", {
          role: "director",
          phase_id: phase.id,
          attempt,
          exit_code: lastExitCode,
          verdict: lastVerdict,
          iterations: result.iterations,
          total_cost_usd: result.total_cost_usd,
          decomposed: result.decomposed,
        });

        // Fire workflow hooks (on_success / on_failure). These are connector
        // task phases (jira/github/ssh/telegram) that the user wired in for
        // reporting / handoff. They run sequentially; a hook failure is logged
        // but doesn't fail the run.
        await fireWorkflowHooks({
          runId,
          project,
          ticket,
          worktrees,
          cwd,
          ok: result.ok,
          lastVerdict,
        });

        if (!result.ok) lastFailedVerdict = lastVerdict;
        // Director is terminal; do not advance to phase.next.
        phase = undefined;
        break;
      }

      // ----- Approval phase: human-in-the-loop pause -----
      if (phase.kind === "approval") {
        emit(runId, "phase_start", {
          role: "approval",
          phase_id: phase.id,
          attempt,
        });
        emit(runId, "awaiting_approval", {
          phase_id: phase.id,
          message: phase.approval?.message ?? null,
        });
        db.prepare(
          `UPDATE runs SET status = 'awaiting_approval', agent_role = ?, current_agent_name = ?, current_phase_id = ?, attempts_by_phase_json = ?, reviewer_feedback = ? WHERE id = ?`,
        ).run(
          "approval",
          `approval:${phase.id}`,
          phase.id,
          JSON.stringify(Object.fromEntries(attemptsByPhase)),
          reviewerFeedback ?? null,
          runId,
        );
        // Exit cleanly — the run is paused. resumeAfterApproval() restarts it.
        return;
      }

      // ----- Task phase: deterministic step, dispatched to registry -----
      // (Normalize legacy kind="command" → kind="task" with shell config.)
      const np = normalizePhase(phase);
      if (np.kind === "task" && np.task) {
        const taskType = np.task.type;
        emit(runId, "phase_start", {
          role: "task",
          phase_id: phase.id,
          attempt,
          task_type: taskType,
        });
        db.prepare(`UPDATE runs SET agent_role = ?, current_agent_name = ?, current_phase_id = ? WHERE id = ?`)
          .run("task", `${taskType}:${phase.id}`, phase.id, runId);

        let cancelledByUser = false;
        const taskVerdict = await runTask(taskType, np.task.config, {
          runId,
          runDir: cwd,
          project,
          ticket,
          phase: np,
          lastVerdict,
          lastWasFailure: lastVerdict ? (lastVerdict as any).ok === false : false,
          emit: (event, payload) => emit(runId, event as RunEventType, payload),
          registerCancel: (c) => {
            cancelHandles.set(runId, () => { cancelledByUser = true; c(); });
          },
          unregisterCancel: () => cancelHandles.delete(runId),
        });

        lastVerdict = taskVerdict as unknown as ReviewVerdict;
        lastExitCode = taskVerdict.ok ? 0 : 1;
        emit(runId, "phase_end", {
          role: "task",
          phase_id: phase.id,
          attempt,
          task_type: taskType,
          exit_code: lastExitCode,
          verdict: lastVerdict,
        });

        db.prepare(
          `UPDATE runs SET attempts_by_phase_json = ?, reviewer_feedback = ? WHERE id = ?`,
        ).run(
          JSON.stringify(Object.fromEntries(attemptsByPhase)),
          reviewerFeedback ?? null,
          runId,
        );

        if (cancelledByUser || wasCancelledNow()) break;

        if (!taskVerdict.ok) {
          lastFailedVerdict = lastVerdict;
          const maxAttempts = phase.max_attempts ?? 2;
          const retryTarget = phase.retry_target ?? null;
          if (retryTarget && attempt < maxAttempts && phaseById.has(retryTarget)) {
            // Pass details to upstream agent so it can fix what broke.
            const tail = taskVerdict.details
              ? `\n\nDetails:\n\`\`\`\n${taskVerdict.details}\n\`\`\``
              : "";
            reviewerFeedback = `Task "${phase.id}" (${taskType}) failed: ${taskVerdict.summary}${tail}`;
            emit(runId, "system", {
              msg: `Phase ${phase.id} (${taskType}) failed — retrying from ${retryTarget} (attempt ${attempt}/${maxAttempts})`,
            });
            phase = phaseById.get(retryTarget);
            continue;
          }
          emit(runId, "system", { msg: `Phase ${phase.id} (${taskType}) failed and no retry available — aborting.` });
          break;
        }

        // Task succeeded — clear stale reviewer feedback.
        reviewerFeedback = undefined;

        const nextId = phase.next ?? null;
        if (!nextId) { phase = undefined; break; }
        const nextPhase = phaseById.get(nextId);
        if (!nextPhase) {
          emit(runId, "system", { msg: `Phase ${phase.id} → "${nextId}" does not exist — aborting.` });
          lastExitCode = 1;
          break;
        }
        phase = nextPhase;
        continue;
      }

      // ----- Agent phase (default) -----
      if (!phase.agent_id) {
        emit(runId, "system", { msg: `Phase ${phase.id} has no agent_id — aborting.` });
        lastExitCode = 1;
        break;
      }
      const agentRecord = loadAgent(phase.agent_id);
      if (!agentRecord || agentRecord.project_id !== project.id) {
        emit(runId, "system", {
          msg: `Phase ${phase.id} references missing agent_id "${phase.agent_id}" — aborting.`,
        });
        lastExitCode = 1;
        break;
      }
      const role = agentRecord.role;
      emit(runId, "phase_start", {
        role,
        phase_id: phase.id,
        attempt,
        agent_id: agentRecord.id,
        agent_name: agentRecord.name,
      });
      db.prepare(`UPDATE runs SET agent_role = ?, current_agent_name = ?, current_phase_id = ? WHERE id = ?`)
        .run(role, agentRecord.name, phase.id, runId);

      const spec = specFromAgent(agentRecord);
      const agentMem = readAgentMemory(project.id, agentRecord.id).trim();
      // Agents that already prescribe a strict verdict shape (CTO, Memory
      // Curator) get just their existing memory appended — adding the
      // self-management protocol would conflict with their JSON contract.
      const agentManagesOwnVerdict =
        agentRecord.name === AGENT_NAMES.CTO ||
        agentRecord.name === AGENT_NAMES.MEMORY_CURATOR;
      if (agentManagesOwnVerdict) {
        if (agentMem) {
          spec.systemPrompt = `${spec.systemPrompt}\n\n## Your accumulated memory for this project\n\n${agentMem}`;
        }
      } else {
        spec.systemPrompt = `${spec.systemPrompt}

## Self-managed memory protocol

You have a private memory for this project. ${agentMem ? "It is included below." : "It is currently empty."} You can update it by adding a \`memory_update\` field to your verdict JSON (alongside ok/summary/issues/etc.):

\`\`\`json
{
  "ok": true,
  "memory_update": {
    "add": ["- Concise imperative bullet, < 80 chars."],
    "remove_matching": ["substring of an obsolete entry to remove"]
  }
}
\`\`\`

Rules:
- Add ONLY genuinely surprising, recurring, role-specific learnings — things you would want to remember next run. NOT generic advice. NOT repeats of project memory or your system prompt.
- Use terse imperative bullets starting with \`- \`.
- Each entry should pay for itself by saving you tool calls or fixing a recurring mistake.
- If you spot a stale/wrong existing entry, add a unique substring of it to \`remove_matching\` to delete.
- Most turns should NOT include memory_update. Only when something noteworthy happened.
- Memory is auto-capped at 30 lines (oldest dropped).${agentMem ? `\n\n## Your accumulated memory for this project\n\n${agentMem}` : ""}`;
      }
      // Pipeline context (who's upstream/downstream) is only useful for
      // roles that decide whether to bounce back. Tester and one-shot agents
      // never route — skip the tokens.
      const includesPipelineContext = role === "coder" || role === "reviewer";
      const ctx: AgentContext = {
        ...baseCtx,
        diffs,
        reviewerFeedback: role === "coder" ? reviewerFeedback : undefined,
        projectSpecifics: workflow.project_specifics ?? null,
        phaseNotes: phase.notes ?? null,
        pipelineContext: includesPipelineContext ? describePipeline(workflow, phase.id) : null,
      };
      // Per-phase agent timeout. Reuses phase.timeout_sec (also used by shell
      // tasks). 0 / unset → no timeout. Caps at 1 hour to prevent runaway.
      const agentTimeoutSec = Math.min(
        Math.max(phase.timeout_sec ?? 0, 0),
        3600,
      );
      let agentTimedOut = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const r = await runAgent(spec, ctx, phaseStreamHandlers, (cancel) => {
        cancelHandles.set(runId, cancel);
        if (agentTimeoutSec > 0) {
          timeoutHandle = setTimeout(() => {
            agentTimedOut = true;
            emit(runId, "system", {
              msg: `Phase ${phase!.id} exceeded ${agentTimeoutSec}s — killing agent.`,
            });
            try { cancel(); } catch { /* ignore */ }
          }, agentTimeoutSec * 1000);
        }
      });
      if (timeoutHandle) clearTimeout(timeoutHandle);
      cancelHandles.delete(runId);
      lastExitCode = r.exitCode;

      // If we killed via timeout, force ok=false so retry/abort kicks in.
      if (agentTimedOut) {
        const summary = `Agent phase "${phase.id}" timed out after ${agentTimeoutSec}s.`;
        if (r.verdict && typeof r.verdict === "object") {
          (r.verdict as any).ok = false;
          (r.verdict as any).summary = summary;
          (r.verdict as any).issues = [
            ...(((r.verdict as any).issues as any[]) ?? []),
            { severity: "blocker", message: summary },
          ];
        } else {
          (r as any).verdict = { ok: false, summary, issues: [{ severity: "blocker", message: summary }] };
        }
      }

      lastVerdict = r.verdict ?? null;
      emit(runId, "phase_end", {
        role,
        phase_id: phase.id,
        attempt,
        agent_id: agentRecord.id,
        agent_name: agentRecord.name,
        exit_code: r.exitCode,
        verdict: lastVerdict,
      });

      // Persist phase progress so we can resume after a server restart.
      db.prepare(
        `UPDATE runs SET attempts_by_phase_json = ?, reviewer_feedback = ? WHERE id = ?`,
      ).run(
        JSON.stringify(Object.fromEntries(attemptsByPhase)),
        reviewerFeedback ?? null,
        runId,
      );

      // Apply any self-managed memory update emitted in the verdict.
      const memUpdate = (lastVerdict as any)?.memory_update;
      if (memUpdate && (Array.isArray(memUpdate.add) || Array.isArray(memUpdate.remove_matching))) {
        try {
          const result = applyMemoryUpdate(project.id, agentRecord.id, memUpdate);
          if (result.added > 0 || result.removed > 0 || result.capped > 0) {
            emit(runId, "system", {
              msg: `Agent "${agentRecord.name}" updated memory: +${result.added} −${result.removed}${result.capped ? ` (capped: −${result.capped})` : ""} (now ${result.final_lines} lines)`,
            });
          }
        } catch (e: any) {
          emit(runId, "system", {
            msg: `Memory update for "${agentRecord.name}" failed: ${e.message ?? e}`,
          });
        }
      }

      if (role === "coder") {
        diffs = await computeDiffs();
      }

      // Hard failure (non-zero exit) → abort.
      if (r.exitCode !== 0) {
        lastFailedVerdict = lastVerdict;
        break;
      }

      // Verdict-driven routing: if verdict.ok === false and a retry target exists, jump.
      const verdictOk = lastVerdict ? (lastVerdict as any).ok !== false : true;
      if (!verdictOk) {
        lastFailedVerdict = lastVerdict;
        const maxAttempts = phase.max_attempts ?? 2;
        const retryTarget = phase.retry_target ?? null;
        if (retryTarget && attempt < maxAttempts && phaseById.has(retryTarget)) {
          // Build feedback for the retry target (if it's a coder phase).
          const issuesText = ((lastVerdict as ReviewVerdict | null)?.issues ?? [])
            .map((i: any) => `- [${i.severity}] ${i.file ?? ""}${i.line ? `:${i.line}` : ""} — ${i.message}`)
            .join("\n");
          const summary = (lastVerdict as any)?.summary ?? "(no summary)";
          reviewerFeedback = `Summary: ${summary}\n\nIssues:\n${issuesText || "(none)"}`;
          emit(runId, "system", {
            msg: `Phase ${phase.id} verdict not ok — retrying from ${retryTarget} (attempt ${attempt}/${maxAttempts})`,
          });
          phase = phaseById.get(retryTarget);
          continue;
        }
        // No retry available; abort.
        emit(runId, "system", { msg: `Phase ${phase.id} verdict not ok and no retry available — aborting.` });
        break;
      }

      // Decomposition shortcut: if the agent's verdict says `decompose: true`,
      // hand the ticket to the CTO decomposer, create subtickets, and end the
      // run. Subtickets get scheduled separately. Parent ticket → 'blocked'.
      if ((lastVerdict as any)?.decompose === true) {
        try {
          const { decomposeTicket } = await import("./ctoDecompose.js");
          const fresh = loadProjectWithRepos(project.id) ?? project;
          emit(runId, "system", {
            msg: `Phase ${phase.id} recommended decomposition — invoking CTO…`,
          });
          const result = await decomposeTicket(fresh, ticket);
          if (result.decomposed) {
            emit(runId, "system", {
              msg: `Decomposed into ${result.created.length} subticket(s): ${result.created.map((t) => t.ticket_key ?? t.id.slice(0, 6)).join(", ")}`,
            });
            db.prepare(
              `UPDATE runs SET status = 'succeeded', finished_at = ?, exit_code = 0 WHERE id = ?`,
            ).run(nowIso(), runId);
            db.prepare(`UPDATE tickets SET status = 'blocked', updated_at = ? WHERE id = ?`)
              .run(nowIso(), ticket.id);
            emit(runId, "done", { status: "succeeded", exit_code: 0, decomposed: true, subticket_count: result.created.length });
            return;
          } else {
            emit(runId, "system", {
              msg: `CTO decided not to decompose: ${result.rationale} — continuing normal routing.`,
            });
          }
        } catch (e: any) {
          // CTO not available or call failed — log and fall through to normal routing.
          emit(runId, "system", {
            msg: `Decompose failed (${e?.message ?? e}) — falling through to normal routing.`,
          });
        }
      }

      // Conditional routing: if verdict has a `route` key and the phase has a
      // matching entry in `routes`, jump there instead of using `next`.
      const route = (lastVerdict as any)?.route;
      const routeTargetId =
        typeof route === "string" && phase.routes && phase.routes[route]
          ? phase.routes[route]
          : null;
      const nextId = routeTargetId ?? phase.next ?? null;
      if (routeTargetId) {
        emit(runId, "system", {
          msg: `Phase ${phase.id} routed via verdict.route="${route}" → ${routeTargetId}`,
        });
      }
      if (!nextId) {
        phase = undefined;
        break;
      }
      const nextPhase = phaseById.get(nextId);
      if (!nextPhase) {
        emit(runId, "system", { msg: `Phase ${phase.id} → "${nextId}" does not exist — aborting.` });
        lastExitCode = 1;
        break;
      }
      phase = nextPhase;
    }

    // Final status.
    let finalStatus: "succeeded" | "failed" | "cancelled";
    if (wasCancelledNow()) {
      finalStatus = "cancelled";
    } else if (lastExitCode !== 0) {
      finalStatus = "failed";
    } else if (lastFailedVerdict && (lastFailedVerdict as any).ok === false) {
      finalStatus = "failed";
    } else {
      finalStatus = "succeeded";
    }

    // Persist final status BEFORE running the Memory Curator. Curator is
    // best-effort (it can fail or hang on a bad LLM response) and must never
    // block the run from completing in the DB / UI.
    db.prepare(
      `UPDATE runs SET status = ?, finished_at = ?, exit_code = ? WHERE id = ?`,
    ).run(finalStatus, nowIso(), lastExitCode, runId);

    // Auto-merge each worktree's HEAD into the parent repo's base branch when
    // the run succeeded. Fast-forward only and only if the parent has no
    // uncommitted changes — never overwrite user state. The user sees results
    // in their IDE without a manual git fetch step.
    //
    // Skip this entirely when the workflow has a git_push gate — that gate
    // already merged worktree → base (squash or ff) and pushed to origin.
    // The local base_branch now diverges from worktree HEAD (squash commit
    // vs raw worktree commits) so ff-only would always fail with a confusing
    // "history diverged" message. The work IS landed.
    const hasGitPushGate = project.workflow.phases.some(
      (p) => p.kind === "task" && p.task?.type === "git_push",
    );
    if (finalStatus === "succeeded" && !hasGitPushGate) {
      for (const wt of worktrees) {
        try {
          const result = await tryFastForwardParent(wt.path, wt.repo_path, wt.base_branch);
          if (result.merged) {
            emit(runId, "system", {
              msg: `auto-merge ${wt.repo_name}: ${wt.base_branch} ← ${result.sha?.slice(0, 7)}`,
            });
          } else {
            emit(runId, "system", {
              msg: `auto-merge ${wt.repo_name}: skipped — ${result.reason}`,
            });
          }
        } catch (e: any) {
          emit(runId, "system", {
            msg: `auto-merge ${wt.repo_name}: error — ${e?.message ?? e}`,
          });
        }
      }
    }

    // Memory Curator: only on succeeded runs, fire-and-forget with timeout.
    if (finalStatus === "succeeded") {
      void runMemoryCuratorSafely({ runId, project, ticket, diffs, cwd });
    }

    // Auto-finalize succeeded runs to `done`. Director already enforces ci_gate
    // (code-level guardrail) and runs Reviewer / Tester before mark_done on
    // non-trivial work — by the time we reach finalStatus='succeeded' the team
    // has self-certified. Manual review-then-done step would block the
    // dependency chain (next subticket can't start until prior is `done`) for
    // little safety gain. Failed runs still go to `blocked` for human triage.
    //
    // If the user marks the run with verdict='bad' / 'broken_in_prod' later,
    // Memory Curator surfaces it as anti-pattern in episodic memory — that's
    // the feedback loop, not pre-blocking the chain.
    const ticketStatus: "done" | "blocked" = finalStatus === "succeeded" ? "done" : "blocked";
    db.prepare(`UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`)
      .run(ticketStatus, nowIso(), ticket.id);

    emit(runId, "done", { status: finalStatus, exit_code: lastExitCode });
  } catch (err: any) {
    const msg = err?.message || String(err);
    db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
    ).run(nowIso(), msg, runId);
    db.prepare(`UPDATE tickets SET status = 'blocked', updated_at = ? WHERE id = ?`)
      .run(nowIso(), ticket.id);
    emit(runId, "system", { msg: `Run failed: ${msg}` });
    emit(runId, "done", { status: "failed", error: msg });
  } finally {
    cancelHandles.delete(runId);
  }
}

/**
 * Signal a running claude process to terminate. Status transition happens
 * in the run engine when the process exits.
 */
export function cancelRun(runId: string): boolean {
  const cancel = cancelHandles.get(runId);
  if (!cancel) return false;
  emit(runId, "system", { msg: "Cancel requested by user" });
  cancel();
  cancelHandles.delete(runId);
  // Mark as cancelled. The engine's exit path will still write finished_at.
  db.prepare(`UPDATE runs SET status = 'cancelled' WHERE id = ?`).run(runId);
  return true;
}

/**
 * Delete a run: clean up worktrees and branches from disk, then remove DB rows.
 * Safe to call on any status.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  const run = loadRun(runId);
  if (!run) return false;
  // Cancel if still running.
  cancelRun(runId);

  const project = loadProject(run.project_id);
  if (project) {
    const repoMap = new Map<string, string>();
    const repoRows = db
      .prepare("SELECT name, local_path FROM repos WHERE project_id = ?")
      .all(run.project_id) as { name: string; local_path: string }[];
    for (const r of repoRows) repoMap.set(r.name, r.local_path);

    await Promise.all(
      run.worktrees.map(async (wt) => {
        const parentPath = repoMap.get(wt.repo_name);
        if (!parentPath) return;
        try {
          await removeWorktree(parentPath, wt.path, run.branch);
        } catch {
          // Best-effort; don't block deletion on cleanup failures.
        }
      }),
    );

    // Remove the run root directory if empty.
    const runRoot = path.join(PROJECTS_DIR, run.project_id, "runs", runId);
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
  }

  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  return true;
}

/** Remove worktrees + branch for a finished run, but KEEP the run row so the
 *  history (events, cost, status) stays intact. Useful for periodic cleanup
 *  of cancelled/failed runs without losing the audit trail. */
export async function cleanupRunArtifacts(runId: string): Promise<boolean> {
  const run = loadRun(runId);
  if (!run) return false;
  if (run.status === "running" || run.status === "pending" || run.status === "awaiting_approval") return false;

  const project = loadProject(run.project_id);
  if (!project) return false;

  const repoRows = db
    .prepare("SELECT name, local_path FROM repos WHERE project_id = ?")
    .all(run.project_id) as { name: string; local_path: string }[];
  const repoMap = new Map<string, string>();
  for (const r of repoRows) repoMap.set(r.name, r.local_path);

  let removedAny = false;
  await Promise.all(
    run.worktrees.map(async (wt) => {
      const parentPath = repoMap.get(wt.repo_name);
      if (!parentPath) return;
      // Skip if already gone.
      if (!fs.existsSync(wt.path)) return;
      try {
        await removeWorktree(parentPath, wt.path, run.branch);
        removedAny = true;
      } catch {
        // Best-effort.
      }
    }),
  );

  // Remove the run root directory if empty.
  const runRoot = path.join(PROJECTS_DIR, run.project_id, "runs", runId);
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}

  // Mark worktrees as cleaned so we don't try again. We keep the run row.
  db.prepare(`UPDATE runs SET worktrees = ? WHERE id = ?`).run("[]", runId);
  return removedAny;
}

/** Periodic cleanup: drop worktrees for cancelled (>12h), failed (>7d), and
 *  succeeded (>30d) runs. Succeeded gets the longest grace period because
 *  the user might still want to push from the worktree shortly after — but
 *  after a month the merge has typically happened and the worktree is just
 *  disk bloat. The run row itself stays (event log, cost, verdict). */
export async function cleanupOldRunArtifacts(): Promise<{ cleaned: number }> {
  const targets = db
    .prepare(
      `SELECT id FROM runs
        WHERE worktrees IS NOT NULL
          AND worktrees != '[]'
          AND (
            (status = 'cancelled' AND finished_at IS NOT NULL AND finished_at < datetime('now', '-12 hours'))
            OR
            (status = 'failed'    AND finished_at IS NOT NULL AND finished_at < datetime('now', '-7 days'))
            OR
            (status = 'succeeded' AND finished_at IS NOT NULL AND finished_at < datetime('now', '-30 days'))
          )`,
    )
    .all() as { id: string }[];
  let cleaned = 0;
  for (const { id } of targets) {
    if (await cleanupRunArtifacts(id)) cleaned++;
  }
  if (cleaned > 0) console.log(`[ceo] cleaned ${cleaned} stale worktree(s)`);
  return { cleaned };
}

export async function deleteRunsForTicket(ticketId: string): Promise<void> {
  const rows = db
    .prepare("SELECT id FROM runs WHERE ticket_id = ?")
    .all(ticketId) as { id: string }[];
  await Promise.all(rows.map((r) => deleteRun(r.id)));
}

/** Wraps runMemoryCurator with a hard timeout and emits clearer error events.
 *  Never throws — caller fires-and-forgets. */
async function runMemoryCuratorSafely(args: {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  diffs: string;
  cwd: string;
}): Promise<void> {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      runMemoryCurator(args).then(() => "ok" as const),
      timeout,
    ]);
    if (result === "timeout") {
      emit(args.runId, "system", {
        msg: `Memory Curator timed out after ${TIMEOUT_MS / 1000}s — skipped.`,
      });
    }
  } catch (e: any) {
    emit(args.runId, "system", {
      msg: `Memory Curator failed: ${e?.message ?? String(e)}`,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runMemoryCurator(args: {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  diffs: string;
  cwd: string;
}): Promise<void> {
  const { runId, project, ticket, diffs, cwd } = args;
  const curator = project.agents.find((a) => a.name === AGENT_NAMES.MEMORY_CURATOR);
  if (!curator) {
    emit(runId, "system", { msg: "Memory Curator skipped (no curator agent in project)." });
    return;
  }

  emit(runId, "system", { msg: "Memory Curator reviewing run..." });

  const prompt = `# Run summary for memory curation

You are reviewing a completed run to decide what (if anything) should be added to the project's shared memory.

## Ticket
**${ticket.title}**

${ticket.body || "(no body)"}

## Diff produced by this run

\`\`\`diff
${diffs || "(no diff captured)"}
\`\`\`

---

Decide. Most runs should add nothing. End with the JSON object as specified in your role.`;

  let res;
  try {
    res = await runAgentOneShot(curator, prompt, cwd);
  } catch (e: any) {
    emit(runId, "system", { msg: `Memory Curator failed: ${e.message ?? e}` });
    return;
  }
  recordCost({
    source: "memory_curator",
    cost_usd: extractCostFromStdout(res.stdout),
    project_id: project.id,
    run_id: runId,
  });

  const parsed = extractJsonWithFallback<{
    rationale?: string;
    memory_update?: { add?: string[]; remove_matching?: string[] };
  }>(res.stdout);

  // extractJsonWithFallback can return null (parse failed) OR a non-object
  // (e.g. the model emitted a string). Distinguish the two so we don't silently
  // drop legitimately-bad output.
  if (parsed === null || parsed === undefined) {
    const tail = res.stdout.length > 400 ? res.stdout.slice(-400) : res.stdout;
    emit(runId, "system", {
      msg: `Memory Curator: could not parse JSON from response. Tail: ${tail.replace(/\n/g, " ").slice(0, 300)}`,
    });
    return;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    emit(runId, "system", {
      msg: `Memory Curator: response was not an object (got ${Array.isArray(parsed) ? "array" : typeof parsed}).`,
    });
    return;
  }
  if (!parsed.memory_update) {
    emit(runId, "system", {
      msg: `Memory Curator returned no update${parsed.rationale ? ` — ${parsed.rationale}` : ""}.`,
    });
    return;
  }

  const update = parsed.memory_update;
  if (
    (!Array.isArray(update.add) || update.add.length === 0) &&
    (!Array.isArray(update.remove_matching) || update.remove_matching.length === 0)
  ) {
    emit(runId, "system", {
      msg: `Memory Curator: no changes${parsed.rationale ? ` — ${parsed.rationale}` : ""}`,
    });
    return;
  }

  const result = applyProjectMemoryUpdate(project.id, update);
  emit(runId, "system", {
    msg: `Project memory updated by Curator: +${result.added} −${result.removed}${
      result.capped ? ` (capped: −${result.capped})` : ""
    } (now ${result.final_lines} lines)${parsed.rationale ? ` — ${parsed.rationale}` : ""}`,
  });
}

/**
 * Build a markdown description of the phase's neighbors in the pipeline so
 * agents understand where they sit (who handed off to them, who reviews next,
 * who they can bounce work to).
 */
/**
 * Build a short markdown bullet list of the most recent succeeded runs in this
 * project (excluding the current run) so agents have episodic memory of what
 * was just done. Capped at 3 entries to keep the prompt cheap.
 */
function buildRecentRunsContext(projectId: string, excludeRunId: string): string | null {
  const rows = db
    .prepare(
      `SELECT r.id AS run_id, r.finished_at,
              r.user_verdict, r.user_verdict_note,
              t.ticket_key AS ticket_key, t.title AS ticket_title
         FROM runs r
         LEFT JOIN tickets t ON t.id = r.ticket_id
        WHERE r.project_id = ?
          AND r.id != ?
          AND r.status = 'succeeded'
          AND r.finished_at IS NOT NULL
        ORDER BY r.finished_at DESC
        LIMIT 3`,
    )
    .all(projectId, excludeRunId) as Array<{
      run_id: string;
      finished_at: string;
      user_verdict: string | null;
      user_verdict_note: string | null;
      ticket_key: string | null;
      ticket_title: string | null;
    }>;
  // Independent pull of negatively-rated runs (regardless of run status — a
  // bad/broken_in_prod run might have been technically `succeeded` or `failed`,
  // doesn't matter, the user said it was wrong). These become explicit
  // anti-pattern lines so the Director / sub-agents avoid repeating mistakes.
  const negativeRows = db
    .prepare(
      `SELECT r.id AS run_id, r.finished_at, r.user_verdict, r.user_verdict_note,
              t.ticket_key AS ticket_key, t.title AS ticket_title
         FROM runs r
         LEFT JOIN tickets t ON t.id = r.ticket_id
        WHERE r.project_id = ?
          AND r.id != ?
          AND r.user_verdict IN ('bad', 'broken_in_prod')
        ORDER BY r.user_verdict_at DESC
        LIMIT 3`,
    )
    .all(projectId, excludeRunId) as Array<{
      run_id: string;
      finished_at: string | null;
      user_verdict: string | null;
      user_verdict_note: string | null;
      ticket_key: string | null;
      ticket_title: string | null;
    }>;

  const sections: string[] = [];

  if (rows.length > 0) {
    const lines = rows.map((r) => {
      const key = r.ticket_key ?? r.run_id.slice(0, 6);
      const title = (r.ticket_title ?? "(no title)").slice(0, 100);
      const when = r.finished_at ? relativeWhen(r.finished_at) : "?";
      const verdictTag = r.user_verdict === "good" ? " ✓ user-approved" : "";
      return `- **${key}** ${title} _(finished ${when}${verdictTag})_`;
    });
    sections.push(lines.join("\n"));
  }

  if (negativeRows.length > 0) {
    const antiLines = negativeRows.map((r) => {
      const key = r.ticket_key ?? r.run_id.slice(0, 6);
      const title = (r.ticket_title ?? "(no title)").slice(0, 100);
      const tag = r.user_verdict === "broken_in_prod" ? "broken in production" : "user-rejected";
      const note = r.user_verdict_note ? ` — ${r.user_verdict_note.slice(0, 200)}` : "";
      return `- **${key}** ${title} _(${tag})_${note}`;
    });
    sections.push(`### Avoid repeating these (anti-patterns)\n${antiLines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

function relativeWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function describePipeline(wf: WorkflowDefinition, phaseId: string): string {
  const phaseById = new Map(wf.phases.map((p) => [p.id, p]));
  const me = phaseById.get(phaseId);
  if (!me) return "";

  const describe = (id: string | null | undefined): string => {
    if (!id) return "";
    const p = phaseById.get(id);
    if (!p) return `${id} (missing)`;
    const np = normalizePhase(p);
    if (np.kind === "task" && np.task) {
      return `\`${np.task.type}\` task (phase: ${id})`;
    }
    if (!p.agent_id) return `${id} (no agent)`;
    const a = loadAgent(p.agent_id);
    if (!a) return `${id} (missing agent)`;
    return `**${a.name}** (role: ${a.role}, phase: ${id})`;
  };

  // Inbound: phases that target this one via next/route/retry_target.
  const inbound: { from: string; via: string }[] = [];
  for (const p of wf.phases) {
    if (p.id === phaseId) continue;
    if (p.next === phaseId) inbound.push({ from: p.id, via: "next" });
    if (p.retry_target === phaseId) inbound.push({ from: p.id, via: "retry" });
    if (p.routes) {
      for (const [key, target] of Object.entries(p.routes)) {
        if (target === phaseId) inbound.push({ from: p.id, via: `route:${key}` });
      }
    }
  }

  const lines: string[] = [];
  if (inbound.length > 0) {
    lines.push("**Upstream (handed off to you):**");
    for (const { from, via } of inbound) {
      lines.push(`- ${describe(from)} — via \`${via}\``);
    }
  }
  if (me.next) {
    lines.push(`**Next on success:** ${describe(me.next)}`);
  } else {
    lines.push("**Next on success:** workflow ends after you.");
  }
  if (me.routes) {
    const entries = Object.entries(me.routes);
    if (entries.length > 0) {
      lines.push("**Conditional routes:** if your verdict has `route: <key>`, the engine jumps to:");
      for (const [key, target] of entries) {
        lines.push(`- \`${key}\` → ${describe(target)}`);
      }
    }
  }
  if (me.retry_target) {
    lines.push(`**On verdict.ok=false:** bounces back to ${describe(me.retry_target)} (max ${me.max_attempts ?? 2} attempts).`);
  }
  return lines.join("\n");
}

/**
 * On server boot: any runs left in 'running' or 'pending' status are orphans
 * (the process that owned them is gone). For each, try to resume by re-entering
 * the workflow at the last persisted phase. If the project / ticket / workflow
 * is missing or invalid, mark the run as failed instead.
 */
export async function resumeOrphanedRuns(): Promise<void> {
  const orphans = db
    .prepare("SELECT id FROM runs WHERE status IN ('running', 'pending')")
    .all() as { id: string }[];
  if (orphans.length === 0) return;

  console.log(`[ceo] resuming ${orphans.length} orphaned run(s) from previous process...`);

  for (const { id: runId } of orphans) {
    const run = loadRun(runId);
    if (!run) continue;

    const project = loadProjectWithRepos(run.project_id);
    const ticket = loadTicket(run.ticket_id);
    if (!project || !ticket) {
      markFailed(runId, ticket?.id, "resume: project or ticket missing");
      continue;
    }

    const repoMap = new Map(project.repos.map((r) => [r.name, r]));
    const worktrees = run.worktrees
      .map((w) => {
        const repo = repoMap.get(w.repo_name);
        if (!repo) return null;
        return {
          repo_name: w.repo_name,
          repo_path: repo.local_path,
          base_branch: repo.default_branch,
          path: w.path,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (worktrees.length === 0) {
      markFailed(runId, ticket.id, "resume: no usable worktrees");
      continue;
    }

    // Restore attempts + feedback that were persisted on the row.
    const row = db
      .prepare("SELECT attempts_by_phase_json, reviewer_feedback FROM runs WHERE id = ?")
      .get(runId) as { attempts_by_phase_json: string | null; reviewer_feedback: string | null } | undefined;
    const restored: ResumeState = {
      attemptsByPhase: row?.attempts_by_phase_json
        ? new Map<string, number>(
            Object.entries(JSON.parse(row.attempts_by_phase_json) as Record<string, number>),
          )
        : undefined,
      reviewerFeedback: row?.reviewer_feedback ?? undefined,
      startPhaseId: run.current_phase_id ?? null,
    };

    emit(runId, "system", {
      msg: `Resuming run after server restart${restored.startPhaseId ? ` (from phase ${restored.startPhaseId})` : ""}.`,
    });

    void executeRun({
      runId,
      ticket,
      project,
      worktrees,
      branch: run.branch,
      resume: restored,
    });
  }
}

/**
 * Resume an awaiting_approval run.
 * approve=true → continue to phase.next.
 * approve=false → treat as verdict ok=false (retry_target if set, else fail).
 * `note` is recorded in run_events for audit.
 */
export function decideApproval(runId: string, approve: boolean, note?: string): boolean {
  // Atomic state transition guards against double-click / concurrent /approve+/reject.
  // Only one caller will see rowsChanged === 1; the rest get false and bail out.
  const transitioned = db
    .prepare(
      `UPDATE runs SET status = 'running' WHERE id = ? AND status = 'awaiting_approval'`,
    )
    .run(runId);
  if (transitioned.changes === 0) return false;

  const run = loadRun(runId);
  if (!run) return false;
  const project = loadProjectWithRepos(run.project_id);
  const ticket = loadTicket(run.ticket_id);
  if (!project || !ticket) {
    // Roll back the status flip we just made if context is unusable.
    db.prepare(`UPDATE runs SET status = 'awaiting_approval' WHERE id = ?`).run(runId);
    return false;
  }

  const phases = project.workflow.phases;
  const current = phases.find((p) => p.id === run.current_phase_id);

  // Director pause-resume path: current_phase_id is the director phase id (or
  // the "director" display id for the implicit one). The implicit director
  // isn't in phases[] so `current` is undefined — handle before the missing-
  // phase guard would mark this run failed.
  const isDirectorPause =
    run.current_phase_id === "director" ||
    run.current_phase_id === "__director__" ||
    current?.kind === "director";
  if (isDirectorPause) {
    return decideDirectorPause(runId, run, project, ticket, approve, note);
  }

  if (!current) {
    markFailed(runId, ticket.id, "approval: current phase missing");
    return false;
  }

  const repoMap = new Map(project.repos.map((r) => [r.name, r]));
  const worktrees = run.worktrees
    .map((w) => {
      const repo = repoMap.get(w.repo_name);
      if (!repo) return null;
      return { repo_name: w.repo_name, repo_path: repo.local_path, base_branch: repo.default_branch, path: w.path };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (worktrees.length === 0) {
    markFailed(runId, ticket.id, "approval: no usable worktrees");
    return false;
  }

  // Restore persisted attempts + feedback.
  const row = db
    .prepare("SELECT attempts_by_phase_json, reviewer_feedback FROM runs WHERE id = ?")
    .get(runId) as { attempts_by_phase_json: string | null; reviewer_feedback: string | null } | undefined;
  const attempts = row?.attempts_by_phase_json
    ? new Map<string, number>(Object.entries(JSON.parse(row.attempts_by_phase_json) as Record<string, number>))
    : undefined;

  if (approve) {
    emit(runId, "system", { msg: `Approval phase "${current.id}" approved${note ? ` — note: ${note}` : ""}.` });
    // Status was already set to 'running' atomically at the top of the function.
    const nextId = current.next ?? null;
    if (!nextId) {
      // No further phases — mark succeeded directly.
      db.prepare(
        `UPDATE runs SET status = 'succeeded', finished_at = ?, exit_code = 0 WHERE id = ?`,
      ).run(nowIso(), runId);
      db.prepare(`UPDATE tickets SET status = 'review', updated_at = ? WHERE id = ?`)
        .run(nowIso(), ticket.id);
      emit(runId, "done", { status: "succeeded", exit_code: 0 });
      return true;
    }
    void executeRun({
      runId,
      ticket,
      project,
      worktrees,
      branch: run.branch,
      resume: { attemptsByPhase: attempts, reviewerFeedback: row?.reviewer_feedback ?? undefined, startPhaseId: nextId },
    });
    return true;
  }

  // Reject: behave like verdict ok=false. If retry_target, jump there.
  emit(runId, "system", { msg: `Approval phase "${current.id}" REJECTED${note ? ` — reason: ${note}` : ""}.` });
  const retryTarget = current.retry_target ?? null;
  const maxAttempts = current.max_attempts ?? 2;
  const currentAttempts = attempts?.get(current.id) ?? 0;
  if (retryTarget && currentAttempts < maxAttempts && phases.some((p) => p.id === retryTarget)) {
    // Status was already set to 'running' atomically at the top of the function.
    void executeRun({
      runId,
      ticket,
      project,
      worktrees,
      branch: run.branch,
      resume: {
        attemptsByPhase: attempts,
        reviewerFeedback: `Approval rejected at "${current.id}"${note ? `: ${note}` : ""}`,
        startPhaseId: retryTarget,
      },
    });
    return true;
  }
  // No retry available — fail.
  markFailed(runId, ticket.id, `approval: rejected${note ? ` (${note})` : ""}`);
  emit(runId, "done", { status: "failed", error: `approval rejected${note ? `: ${note}` : ""}` });
  return true;
}

/** Director pause-resume: approve = extend budget by ~50% and resume the
 *  Director phase; reject = cancel the run. The status transition to 'running'
 *  has already been applied atomically by decideApproval(). */
function decideDirectorPause(
  runId: string,
  run: Run,
  project: ProjectWithRepos,
  ticket: Ticket,
  approve: boolean,
  note: string | undefined,
): boolean {
  const repoMap = new Map(project.repos.map((r) => [r.name, r]));
  const worktrees = run.worktrees
    .map((w) => {
      const repo = repoMap.get(w.repo_name);
      if (!repo) return null;
      return { repo_name: w.repo_name, repo_path: repo.local_path, base_branch: repo.default_branch, path: w.path };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (worktrees.length === 0) {
    markFailed(runId, ticket.id, "director resume: no usable worktrees");
    return false;
  }

  // Pause reason determines resume semantics — set when the director paused.
  const pauseRow = db
    .prepare(`SELECT pause_reason FROM runs WHERE id = ?`)
    .get(runId) as { pause_reason: string | null } | undefined;
  const pauseReason = pauseRow?.pause_reason ?? "budget_exhausted";

  if (!approve) {
    const cancelReasonLabel = pauseReason === "human_review" ? "human_review rejected"
      : pauseReason === "max_iterations" ? "max-iterations extension rejected"
      : "budget extension rejected";
    db.prepare(
      `UPDATE runs SET status = 'cancelled', finished_at = ?, error = ?, pause_reason = NULL WHERE id = ?`,
    ).run(nowIso(), `cancelled: ${cancelReasonLabel}${note ? ` (${note})` : ""}`, runId);
    db.prepare(`UPDATE tickets SET status = 'blocked', updated_at = ? WHERE id = ?`)
      .run(nowIso(), ticket.id);
    if (pauseReason === "human_review") {
      emit(runId, "director_human_review_resolved", { approved: false, note: note ?? "" });
    }
    emit(runId, "system", { msg: `Director paused — rejected${note ? ` (${note})` : ""}. Run cancelled.` });
    emit(runId, "done", { status: "cancelled", error: `cancelled by user${note ? `: ${note}` : ""}` });
    return true;
  }

  // Approve path. Behavior depends on why we paused.
  if (pauseReason === "human_review") {
    emit(runId, "director_human_review_resolved", { approved: true, note: note ?? "" });
    emit(runId, "system", {
      msg: `Director resuming with user input${note ? `: ${note}` : " (no note)"}.`,
    });
    db.prepare(`UPDATE runs SET pause_reason = NULL WHERE id = ?`).run(runId);
  } else if (pauseReason === "max_iterations") {
    // Extend iteration cap by +10. Same pattern as budget extension but for
    // turn budget. Typically used when Director burned early turns on fix
    // loops and ran out before reaching git_push + mark_done.
    const overrideRow = db
      .prepare(`SELECT director_max_iter_override FROM runs WHERE id = ?`)
      .get(runId) as { director_max_iter_override: number | null } | undefined;
    const projectMaxIter = project.workflow.director_config?.max_iterations ?? null;
    const currentMaxIter = overrideRow?.director_max_iter_override ?? projectMaxIter ?? 25;
    const newMaxIter = currentMaxIter + 10;
    db.prepare(`UPDATE runs SET director_max_iter_override = ?, pause_reason = NULL WHERE id = ?`)
      .run(newMaxIter, runId);
    emit(runId, "system", {
      msg: `Director iterations extended: ${currentMaxIter} → ${newMaxIter} (+10). Resuming.`,
    });
  } else {
    // Budget pause: extend by 50% with $5 floor.
    const overrideRow = db
      .prepare(`SELECT director_budget_override_usd FROM runs WHERE id = ?`)
      .get(runId) as { director_budget_override_usd: number | null } | undefined;
    const projectBudget = project.workflow.director_config?.budget_usd ?? null;
    const currentBudget = overrideRow?.director_budget_override_usd ?? projectBudget ?? 20;
    const extension = Math.max(5, Math.round(currentBudget * 0.5));
    const newBudget = currentBudget + extension;
    db.prepare(`UPDATE runs SET director_budget_override_usd = ?, pause_reason = NULL WHERE id = ?`)
      .run(newBudget, runId);
    emit(runId, "system", {
      msg: `Director budget extended: $${currentBudget.toFixed(2)} → $${newBudget.toFixed(2)} (+$${extension}). Resuming.`,
    });
  }

  // Re-enter the Director phase. History is rebuilt from events inside
  // runDirectorPhase, so we don't need to pass any resume state — but we DO
  // need startPhaseId to bypass the default first-phase entry.
  void executeRun({
    runId,
    ticket,
    project,
    worktrees,
    branch: run.branch,
    resume: { startPhaseId: run.current_phase_id ?? "director" },
  });
  return true;
}

/** Fire all connector phases after a Director run terminates. Each connector
 *  task internally filters its actions by trigger (`on: always|success|failure`)
 *  vs the run outcome — the engine just runs them; the task decides what
 *  (if anything) to do. Hook failures are logged, never fail the run. */
async function fireWorkflowHooks(args: {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  worktrees: { repo_name: string; repo_path: string; base_branch: string; path: string }[];
  cwd: string;
  ok: boolean;
  lastVerdict: ReviewVerdict | TestVerdict | null;
}): Promise<void> {
  const { runId, project, ticket, cwd, ok, lastVerdict } = args;
  const wf = project.workflow;

  // Connector phases auto-fire at terminal — no opt-in needed. Each phase's
  // task config carries its own per-action `on` triggers.
  const connectorPhases = wf.phases
    .map((p) => normalizePhase(p))
    .filter((p) => p.kind === "task" && p.task && CONNECTOR_TASK_TYPES.has(p.task.type));

  if (connectorPhases.length === 0) return;

  for (const phase of connectorPhases) {
    if (!phase.task) continue;
    emit(runId, "phase_start", { role: "hook", phase_id: phase.id, hook_type: ok ? "on_success" : "on_failure" });
    const taskCtx = {
      runId,
      runDir: cwd,
      project,
      ticket,
      phase,
      lastVerdict,
      lastWasFailure: !ok,
      emit: (event: string, payload: Record<string, unknown>) => emit(runId, event as RunEventType, payload),
      registerCancel: (c: () => void) => cancelHandles.set(runId, c),
      unregisterCancel: () => cancelHandles.delete(runId),
    };
    try {
      const verdict = await runTask(phase.task.type, phase.task.config, taskCtx);
      emit(runId, "phase_end", {
        role: "hook",
        phase_id: phase.id,
        exit_code: verdict.ok ? 0 : 1,
        verdict,
      });
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      emit(runId, "system", { msg: `[hooks] "${phase.id}" threw: ${m}` });
    }
  }
}

function markFailed(runId: string, ticketId: string | undefined, reason: string) {
  db.prepare(
    `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
  ).run(nowIso(), reason, runId);
  if (ticketId) {
    db.prepare(`UPDATE tickets SET status = 'blocked', updated_at = ? WHERE id = ?`)
      .run(nowIso(), ticketId);
  }
}

