import { db } from "./db.js";
import { loadProjectWithRepos, loadTicket, todaysCostForProject } from "./store.js";
import { startRun } from "./runs.js";
import type { Ticket, SchedulerMode, SchedulerStatus } from "@ceo/shared";

interface State {
  mode: SchedulerMode;
  maxConcurrent: number;
  tickIntervalMs: number;
  timer: NodeJS.Timeout | null;
  /** When set (ISO timestamp), tick() stops starting new runs once we pass it.
   *  In-flight runs are NOT killed — they drain naturally. Use case: "burn
   *  current API quota then stop before the new bucket starts". Cleared when
   *  the deadline fires (auto-pauses mode). */
  pauseAfter: string | null;
}

// Persist scheduler mode in `kv` so server restart / tsx watch reload doesn't
// silently flip it back to paused. User-visible toggle survives across
// restarts; default for fresh install stays "paused" (safer).
function ensureKvTable(): void {
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}
function loadPersistedMode(): SchedulerMode {
  try {
    ensureKvTable();
    const row = db.prepare(`SELECT value FROM kv WHERE key = 'scheduler.mode'`).get() as { value: string } | undefined;
    if (row?.value === "running" || row?.value === "paused") return row.value;
  } catch { /* best-effort */ }
  return "paused";
}
function persistMode(mode: SchedulerMode): void {
  try {
    ensureKvTable();
    db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('scheduler.mode', ?)`).run(mode);
  } catch { /* best-effort */ }
}
function loadPersistedPauseAfter(): string | null {
  try {
    ensureKvTable();
    const row = db.prepare(`SELECT value FROM kv WHERE key = 'scheduler.pause_after'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch { return null; }
}
function persistPauseAfter(iso: string | null): void {
  try {
    ensureKvTable();
    if (iso === null) {
      db.prepare(`DELETE FROM kv WHERE key = 'scheduler.pause_after'`).run();
    } else {
      db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('scheduler.pause_after', ?)`).run(iso);
    }
  } catch { /* best-effort */ }
}

const state: State = {
  mode: loadPersistedMode(),
  maxConcurrent: 2,
  tickIntervalMs: 5000,
  timer: null,
  pauseAfter: loadPersistedPauseAfter(),
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
  // Only runs whose ticket EXPLICITLY declared `repos_touched` contribute —
  // unscoped runs don't lock (their worktrees touch all repos for safety, but
  // they accept concurrent siblings).
  const rows = db
    .prepare(
      `SELECT r.project_id, r.worktrees, t.repos_touched
         FROM runs r
         JOIN tickets t ON t.id = r.ticket_id
        WHERE r.status IN ('pending', 'running')`,
    )
    .all() as { project_id: string; worktrees: string; repos_touched: string | null }[];
  const locked = new Set<string>();
  for (const r of rows) {
    let touchedDeclared: string[] = [];
    try {
      touchedDeclared = r.repos_touched ? (JSON.parse(r.repos_touched) as string[]) : [];
    } catch {}
    if (touchedDeclared.length === 0) continue; // unscoped — don't lock
    try {
      const wts = JSON.parse(r.worktrees) as { repo_name: string }[];
      for (const w of wts) {
        if (touchedDeclared.includes(w.repo_name)) {
          locked.add(`${r.project_id}::${w.repo_name}`);
        }
      }
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

  // Pause-after deadline: stop starting new runs (in-flight runs keep going).
  // First tick that observes the deadline flips mode to paused so the user
  // sees a clear state change in the UI, then clears the deadline.
  if (state.pauseAfter && Date.now() >= new Date(state.pauseAfter).getTime()) {
    console.log(`[scheduler] pause-after deadline ${state.pauseAfter} reached — pausing new starts`);
    state.pauseAfter = null;
    persistPauseAfter(null);
    state.mode = "paused";
    persistMode("paused");
    return;
  }

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

    // Repo-lock policy: only enforce when the ticket EXPLICITLY declares which
    // repos it touches. Tickets with `repos_touched=[]` (the common case from
    // bulk import / CTO decompose without explicit hints) don't lock anything
    // — each run gets its own per-repo worktree branch, so physical git
    // conflicts don't happen; merge-time conflicts are a soft concern and the
    // user can review per-branch before merging.
    let touched: string[];
    if (ticket.repos_touched.length > 0) {
      touched = ticket.repos_touched.filter((r) => project.repos.some((p) => p.name === r));
      if (touched.length === 0) continue;
      const conflict = touched.some((r) => locked.has(`${project.id}::${r}`));
      if (conflict) continue;
    } else {
      // No declared repos → run touches all (used for worktree creation), but
      // doesn't acquire the project-wide lock. Multiple unscoped tickets per
      // project can run in parallel.
      touched = project.repos.map((r) => r.name);
    }

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
      // Mark explicitly-declared repos as locked for the rest of this tick.
      // Unscoped tickets (touched-all-by-default) don't lock — see the policy
      // comment above.
      if (ticket.repos_touched.length > 0) {
        for (const r of touched) locked.add(`${project.id}::${r}`);
      }
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
  persistMode(mode);
  // Manually toggling clears any pending auto-pause so the two controls don't fight.
  if (state.pauseAfter !== null) {
    state.pauseAfter = null;
    persistPauseAfter(null);
  }
  if (mode === "running") void tick();
  return getStatus();
}

export function setPauseAfter(iso: string | null): SchedulerStatus {
  state.pauseAfter = iso;
  persistPauseAfter(iso);
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
    pause_after: state.pauseAfter,
  };
}
