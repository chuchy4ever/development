import { db } from "./db.js";
import { loadProjectWithRepos, loadTicket, todaysCostForProject } from "./store.js";
import { startRun } from "./runs.js";
import type { Ticket, SchedulerMode, SchedulerStatus } from "@ceo/shared";

interface State {
  mode: SchedulerMode;
  maxConcurrent: number;
  tickIntervalMs: number;
  timer: NodeJS.Timeout | null;
}

const state: State = {
  mode: "paused",
  maxConcurrent: 2,
  tickIntervalMs: 5000,
  timer: null,
};

const PRIORITY_ORDER: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function activeRunCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM runs WHERE status IN ('pending', 'running')`,
    )
    .get() as { n: number };
  return row.n;
}

function reposLockedByActiveRuns(): Set<string> {
  // Returns set of "<projectId>::<repoName>" pairs currently in active runs.
  const rows = db
    .prepare(
      `SELECT project_id, worktrees FROM runs WHERE status IN ('pending', 'running')`,
    )
    .all() as { project_id: string; worktrees: string }[];
  const locked = new Set<string>();
  for (const r of rows) {
    try {
      const wts = JSON.parse(r.worktrees) as { repo_name: string }[];
      for (const w of wts) locked.add(`${r.project_id}::${w.repo_name}`);
    } catch {}
  }
  return locked;
}

function eligibleBacklogTickets(): Ticket[] {
  const rows = db
    .prepare(
      `SELECT * FROM tickets WHERE status = 'backlog' ORDER BY created_at ASC`,
    )
    .all() as any[];
  const tickets = rows.map((r) => ({
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    body: r.body,
    status: r.status as Ticket["status"],
    priority: r.priority as Ticket["priority"],
    workflow_template: r.workflow_template,
    repos_touched: r.repos_touched ? JSON.parse(r.repos_touched) : [],
    depends_on: r.depends_on ? JSON.parse(r.depends_on) : [],
    parent_ticket_id: r.parent_ticket_id,
    triage_notes: r.triage_notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  })) as Ticket[];

  // Filter by satisfied dependencies.
  return tickets.filter((t) => {
    if (t.depends_on.length === 0) return true;
    const placeholders = t.depends_on.map(() => "?").join(",");
    const undone = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tickets WHERE id IN (${placeholders}) AND status != 'done'`,
      )
      .get(...t.depends_on) as { n: number };
    return undone.n === 0;
  });
}

function rankTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? "P3"] ?? 3;
    const pb = PRIORITY_ORDER[b.priority ?? "P3"] ?? 3;
    if (pa !== pb) return pa - pb;
    return a.created_at.localeCompare(b.created_at);
  });
}

async function tick(): Promise<void> {
  if (state.mode !== "running") return;

  const slots = state.maxConcurrent - activeRunCount();
  if (slots <= 0) return;

  const candidates = rankTickets(eligibleBacklogTickets());
  if (candidates.length === 0) return;

  const locked = reposLockedByActiveRuns();
  // Cache today's cost per project once per tick — many candidates may target
  // the same project, no need to re-query the SUM for each.
  const todaysCostByProject = new Map<string, number>();
  let started = 0;

  for (const ticket of candidates) {
    if (started >= slots) break;
    const project = loadProjectWithRepos(ticket.project_id);
    if (!project || project.repos.length === 0) continue;

    // Determine which repos this ticket would touch.
    const touched = ticket.repos_touched.length > 0
      ? ticket.repos_touched.filter((r) => project.repos.some((p) => p.name === r))
      : project.repos.map((r) => r.name);
    if (touched.length === 0) continue;

    // Repo-lock check.
    const conflict = touched.some((r) => locked.has(`${project.id}::${r}`));
    if (conflict) continue;

    // Daily cost cap pre-flight: skip if project is over its cap for today.
    if (typeof project.daily_cost_cap_usd === "number" && project.daily_cost_cap_usd > 0) {
      let today = todaysCostByProject.get(project.id);
      if (today === undefined) {
        today = todaysCostForProject(project.id);
        todaysCostByProject.set(project.id, today);
      }
      if (today >= project.daily_cost_cap_usd) {
        continue; // silent skip; Admin UI shows the cap state
      }
    }

    // Start.
    try {
      await startRun({ project, ticket });
      // Mark these repos as locked for the rest of this tick.
      for (const r of touched) locked.add(`${project.id}::${r}`);
      started++;
    } catch (err) {
      console.error("[scheduler] failed to start run for", ticket.id, err);
    }
  }
}

export function startScheduler() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void tick().catch((e) => console.error("[scheduler] tick error", e));
  }, state.tickIntervalMs);
  // Don't keep the event loop alive just for the scheduler.
  state.timer.unref?.();
}

export function setMode(mode: SchedulerMode): SchedulerStatus {
  state.mode = mode;
  if (mode === "running") void tick();
  return getStatus();
}

export function setMaxConcurrent(n: number): SchedulerStatus {
  state.maxConcurrent = Math.max(1, Math.min(10, Math.floor(n)));
  return getStatus();
}

export function getStatus(): SchedulerStatus {
  const queue = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status = 'backlog'`)
    .get() as { n: number };
  return {
    mode: state.mode,
    active_runs: activeRunCount(),
    max_concurrent: state.maxConcurrent,
    queue_depth: queue.n,
  };
}
