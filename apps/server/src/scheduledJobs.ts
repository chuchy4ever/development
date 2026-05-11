/**
 * Scheduled jobs — generic { trigger, action } runner.
 *
 * Trigger types:
 *   - cron:  fires on cron / @once schedule, action runs unconditionally.
 *   - watch: polls an external source (GitHub Search / Jira JQL), dedupes by
 *            stable IDs in `state_json.seen_ids`, fires action once per NEW
 *            item. First poll records a baseline (no fire) so enabling a
 *            watch on a busy query doesn't dispatch hundreds of tickets.
 *
 * Action types:
 *   - create_ticket:    insert ticket (optionally auto-start a Director run).
 *   - telegram_digest:  push deterministic stats to a Telegram chat (no LLM).
 *   - scheduler_mode:   flip the backlog scheduler running/paused.
 *
 * Backward compat: jobs persisted with the old { kind, payload } shape are
 * normalized on read into { trigger: cron, action: <derived> }, so existing
 * data keeps working through the upgrade.
 */

import { CronExpressionParser } from "cron-parser";
import { nanoid } from "nanoid";
import { db, nowIso } from "./db.js";
import { startRun } from "./runs.js";
import { loadProjectWithRepos, loadTicket } from "./store.js";
import { allocateTicketKey } from "./backfillTicketKeys.js";
import { setMode as setSchedulerMode } from "./scheduler.js";
import { sendTelegramMessage } from "./telegramOut.js";
import { TELEGRAM_OUTPUT_CHAT_ID } from "./config.js";
import { getProjectSecret } from "./projectSecrets.js";
import { getGlobalSecret } from "./globalSecrets.js";
import { runAgentOneShot } from "./oneShot.js";
import { extractCostFromStdout, recordCost } from "./costLog.js";
import { extractJsonWithFallback } from "./jsonUtil.js";
import type {
  CreateScheduledJobInput,
  ScheduledJob,
  ScheduledJobAction,
  ScheduledJobTrigger,
  CreateTicketAction,
  TelegramDigestAction,
  TelegramMessageAction,
  SchedulerModeAction,
  ReviewPrAction,
  WebhookAction,
  GithubOpAction,
  WatchTrigger,
  CronTrigger,
  UpdateScheduledJobInput,
  InlineReviewComment,
  ReviewerOutput,
  ReviewSeverity,
} from "@ceo/shared";
import { REVIEW_SEVERITIES } from "@ceo/shared";

const TICK_MS = 30_000;
let tickTimer: NodeJS.Timeout | null = null;

interface RawJobRow {
  id: string;
  name: string;
  project_id: string | null;
  kind: string; // legacy column — repurposed to store trigger.type for new jobs
  schedule: string; // legacy column — repurposed to store next-fire cron
  next_run_at: string | null;
  last_run_at: string | null;
  enabled: number;
  payload_json: string;
  state_json: string | null;
  created_at: string;
  updated_at: string;
}

interface JobState {
  /** Watch dedup. Two shapes co-exist:
   *   - seen_ids[]      : legacy id-only ("seen this PR ever")
   *   - seen_prs{id:{}} : new (review_pr-aware) — tracks last commit SHA per
   *                       PR so a new commit on an already-reviewed PR re-fires.
   *  Both can be present for backward compat; new writes use seen_prs. */
  seen_ids?: string[];
  seen_prs?: Record<string, { sha: string; updated_at: string }>;
  /** Set after the first watch poll completes — until then, no actions fire. */
  baseline_recorded?: boolean;
  /** ISO timestamp of the most recent successful poll (for diagnostics). */
  last_polled_at?: string;
  /** Ring buffer of recent action results (for UI display + audit). Capped.
   *  For fan-out jobs this lives at the OUTER level only; each entry carries
   *  project_id so the user sees which project produced it. */
  recent_results?: { at: string; summary: string; url?: string; project_id?: string }[];
  /** Fan-out only: per-project sub-states. Each value is a JobState as if
   *  the job were single-scoped to that project. dedup, baseline, polling
   *  timestamps live INSIDE the sub-state, not at the outer level. */
  per_project?: Record<string, JobState>;
}

const MAX_RECENT_RESULTS = 10;

// ---- Persistence helpers ----------------------------------------------------

function rowToJob(r: RawJobRow): ScheduledJob {
  const { trigger, action, fan_out_project_ids } = parsePayload(r);
  let state: JobState = {};
  try { state = r.state_json ? JSON.parse(r.state_json) : {}; } catch { /* ignore */ }
  return {
    id: r.id,
    name: r.name,
    project_id: r.project_id,
    fan_out_project_ids: fan_out_project_ids && fan_out_project_ids.length > 0 ? fan_out_project_ids : undefined,
    trigger,
    action,
    schedule: deriveScheduleFromTrigger(trigger), // legacy convenience for older clients
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    enabled: !!r.enabled,
    recent_results: state.recent_results ?? [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  } as ScheduledJob & { schedule?: string };
}

/** Read the persisted blob and produce a normalized { trigger, action,
 *  fan_out_project_ids }. The payload column carries either:
 *   - new shape: { trigger, action, fan_out_project_ids? }
 *   - legacy:    one of TicketJobPayload / DigestJobPayload / SchedulerModeJobPayload
 *     and the row's `kind` column tells us which.
 *  Legacy rows are silently lifted into a CronTrigger using r.schedule. */
function parsePayload(r: RawJobRow): {
  trigger: ScheduledJobTrigger;
  action: ScheduledJobAction;
  fan_out_project_ids?: string[];
} {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(r.payload_json || "{}") as Record<string, unknown>; }
  catch { /* fall through with empty */ }

  if (raw.trigger && raw.action) {
    // Validate the discriminator + minimal shape so a corrupt DB row surfaces
    // here as a quarantined row, not a crash deep in runAction.
    const trigger = validateTriggerShape(raw.trigger);
    const action = validateActionShape(raw.action);
    if (trigger && action) {
      return {
        trigger,
        action,
        fan_out_project_ids: Array.isArray(raw.fan_out_project_ids) ? raw.fan_out_project_ids as string[] : undefined,
      };
    }
    console.warn(`[jobs] payload validation failed for ${r.id} "${r.name}" — falling back to legacy parse`);
    // fall through to legacy path
  }

  // Legacy: r.kind ∈ {ticket, digest, scheduler_mode}, schedule on row.
  const trigger: CronTrigger = { type: "cron", schedule: r.schedule };
  if (r.kind === "ticket") {
    return {
      trigger,
      action: {
        type: "create_ticket",
        title: String(raw.title ?? "(unnamed)"),
        body: String(raw.body ?? ""),
        priority: raw.priority as CreateTicketAction["priority"],
        auto_start: !!raw.auto_start,
      },
    };
  }
  if (r.kind === "digest") {
    return {
      trigger,
      action: {
        type: "telegram_digest",
        chat_id: typeof raw.chat_id === "number" ? raw.chat_id : undefined,
        lookback_hours: typeof raw.lookback_hours === "number" ? raw.lookback_hours : undefined,
      },
    };
  }
  if (r.kind === "scheduler_mode") {
    return {
      trigger,
      action: {
        type: "scheduler_mode",
        mode: (raw.mode === "paused" ? "paused" : "running"),
      },
    };
  }
  // Unknown legacy → return as-is best-effort.
  return {
    trigger,
    action: { type: "create_ticket", title: r.name, body: "" } as CreateTicketAction,
  };
}

function deriveScheduleFromTrigger(t: ScheduledJobTrigger): string {
  return t.type === "cron" ? t.schedule : t.poll_schedule;
}

function readState(r: RawJobRow): JobState {
  if (!r.state_json) return {};
  try { return JSON.parse(r.state_json) as JobState; } catch { return {}; }
}

function writeState(jobId: string, state: JobState): void {
  db.prepare(`UPDATE scheduled_jobs SET state_json = ? WHERE id = ?`)
    .run(JSON.stringify(state), jobId);
}

/** Append one row to job_runs (persistent execution log). Called on every
 *  action invocation and on trigger errors — but NOT on chatty cases like
 *  "no items / baseline recorded" since the bell would drown in noise. */
/** Detect error-shaped result strings produced by action handlers. We sniff
 *  rather than require an `error:` prefix because runReviewPr returns failure
 *  messages in many shapes ("review_pr: failed to fetch …", "review_pr: HTTP
 *  422 …", "review_pr: reviewer failed — …"). All actions should ideally
 *  return ActionResult with an explicit `ok` flag, but until that refactor
 *  this regex is the bridge. */
function isErrorResult(result: string): boolean {
  return (
    result.startsWith("error:")
    || / failed\b/i.test(result)
    || /\bHTTP [4-5]\d\d\b/.test(result)
    || / crashed\b/i.test(result)
  );
}

function recordJobRun(args: {
  job: ScheduledJob;
  effective_project_id: string | null;
  ok: boolean;
  notable: boolean;
  summary: string;
  url?: string;
  /** Optional structured payload (e.g. ReviewerOutput) — surfaces in the UI
   *  expandable view. Capped at ~16KB to keep the table small. */
  details?: unknown;
}): void {
  let detailsJson: string | null = null;
  if (args.details) {
    const s = JSON.stringify(args.details);
    detailsJson = s.length > 16_000 ? s.slice(0, 16_000) + '"…[truncated]"' : s;
  }
  db.prepare(
    `INSERT INTO job_runs (job_id, job_name, action_type, project_id, fired_at, ok, notable, summary, url, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.job.id,
    args.job.name,
    args.job.action.type,
    args.effective_project_id,
    nowIso(),
    args.ok ? 1 : 0,
    args.notable ? 1 : 0,
    args.summary,
    args.url ?? null,
    detailsJson,
  );
}

// ---- Schedule parsing -------------------------------------------------------

export function computeNextRun(schedule: string, after: Date = new Date()): Date | null {
  const trimmed = schedule.trim();
  if (trimmed.startsWith("@once:")) {
    const iso = trimmed.slice("@once:".length).trim();
    const ts = new Date(iso);
    if (Number.isNaN(ts.getTime())) {
      throw new Error(`Invalid @once timestamp "${iso}" — use ISO 8601 (e.g. 2026-12-01T09:00:00Z)`);
    }
    return ts > after ? ts : null;
  }
  return CronExpressionParser.parse(trimmed, { currentDate: after }).next().toDate();
}

// ---- Validation -------------------------------------------------------------

/** Read-side validators: distinct from the throw-on-invalid `validateTrigger`/
 *  `validateAction` used at create/update. These are forgiving — return null
 *  on bad shapes so the caller can fall back / log instead of throwing.
 *  Used by parsePayload to guard against corrupt persisted rows. */
function validateTriggerShape(t: unknown): ScheduledJobTrigger | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (o.type === "cron" && typeof o.schedule === "string") {
    return { type: "cron", schedule: o.schedule };
  }
  if (o.type === "watch"
    && (o.source === "github" || o.source === "jira")
    && typeof o.query === "string"
    && typeof o.poll_schedule === "string") {
    return { type: "watch", source: o.source, query: o.query, poll_schedule: o.poll_schedule };
  }
  return null;
}

function validateActionShape(a: unknown): ScheduledJobAction | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (o.type === "create_ticket" && typeof o.title === "string" && typeof o.body === "string") {
    return o as unknown as CreateTicketAction;
  }
  if (o.type === "telegram_digest") return o as unknown as TelegramDigestAction;
  if (o.type === "scheduler_mode" && (o.mode === "running" || o.mode === "paused")) {
    return o as unknown as SchedulerModeAction;
  }
  if (o.type === "review_pr") return o as unknown as ReviewPrAction;
  if (o.type === "telegram_message" && typeof o.text === "string") return o as unknown as TelegramMessageAction;
  if (o.type === "webhook" && typeof o.url === "string" && typeof o.body_template === "string") {
    return o as unknown as WebhookAction;
  }
  if (o.type === "github_op" && o.github && typeof o.github === "object") {
    return o as unknown as GithubOpAction;
  }
  return null;
}

function validateTrigger(trigger: ScheduledJobTrigger): void {
  if (trigger.type === "cron") {
    computeNextRun(trigger.schedule); // throws on bad syntax
    return;
  }
  if (trigger.type === "watch") {
    if (trigger.source !== "github" && trigger.source !== "jira") {
      throw new Error(`watch trigger source must be "github" or "jira"`);
    }
    if (!trigger.query?.trim()) throw new Error("watch trigger requires a query");
    computeNextRun(trigger.poll_schedule);
    return;
  }
  throw new Error(`unknown trigger type "${(trigger as { type: string }).type}"`);
}

function validateAction(action: ScheduledJobAction, projectId: string | null): void {
  if (action.type === "create_ticket") {
    if (!action.title?.trim()) throw new Error("create_ticket requires a title");
    if (typeof action.body !== "string") throw new Error("create_ticket body must be a string");
    if (!projectId) throw new Error("create_ticket action requires project_id on the job");
    return;
  }
  if (action.type === "telegram_digest") {
    if (action.lookback_hours !== undefined && (typeof action.lookback_hours !== "number" || action.lookback_hours <= 0)) {
      throw new Error("telegram_digest.lookback_hours must be a positive number");
    }
    return;
  }
  if (action.type === "scheduler_mode") {
    if (action.mode !== "running" && action.mode !== "paused") {
      throw new Error('scheduler_mode action requires mode="running"|"paused"');
    }
    return;
  }
  if (action.type === "review_pr") {
    // review_pr supports both project-scope (uses project secrets + agents)
    // and global-scope (uses GITHUB_TOKEN env + admin Skill template).
    return;
  }
  if (action.type === "telegram_message") {
    if (!action.text?.trim()) throw new Error("telegram_message requires non-empty text");
    return;
  }
  if (action.type === "webhook") {
    if (!action.url?.trim()) throw new Error("webhook requires url");
    if (action.body_template === undefined) throw new Error("webhook requires body_template");
    if (action.method && !["POST", "PUT", "PATCH"].includes(action.method)) {
      throw new Error('webhook method must be POST, PUT, or PATCH');
    }
    return;
  }
  if (action.type === "github_op") {
    if (!action.github) throw new Error("github_op requires github operation config");
    if (!action.github.repo) throw new Error("github_op requires repo (owner/name)");
    return;
  }
  throw new Error(`unknown action type "${(action as { type: string }).type}"`);
}

// ---- CRUD -------------------------------------------------------------------

export function listJobs(filter: { project_id?: string | null } = {}): ScheduledJob[] {
  let sql = "SELECT * FROM scheduled_jobs";
  const args: unknown[] = [];
  if (filter.project_id !== undefined) {
    if (filter.project_id === null) {
      sql += " WHERE project_id IS NULL";
    } else {
      sql += " WHERE project_id = ?";
      args.push(filter.project_id);
    }
  }
  sql += " ORDER BY enabled DESC, COALESCE(next_run_at, '9999') ASC, created_at DESC";
  return (db.prepare(sql).all(...args) as RawJobRow[]).map(rowToJob);
}

export function getJob(id: string): ScheduledJob | null {
  const r = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as RawJobRow | undefined;
  return r ? rowToJob(r) : null;
}

export function createJob(input: CreateScheduledJobInput): ScheduledJob {
  validateTrigger(input.trigger);
  // For fan-out, action validation must pass for ANY project — we delegate
  // by validating against the first listed id (others share the same shape
  // since fan-out implies "same job, different projects").
  const validateAgainstProjectId = input.fan_out_project_ids?.[0] ?? input.project_id ?? null;
  validateAction(input.action, validateAgainstProjectId);
  validateFanOut(input.fan_out_project_ids);
  const enabled = input.enabled === false ? 0 : 1;
  const schedule = deriveScheduleFromTrigger(input.trigger);
  const nextRun = enabled ? computeNextRun(schedule) : null;
  const id = nanoid(10);
  const now = nowIso();
  const fanOut = input.fan_out_project_ids && input.fan_out_project_ids.length > 0 ? input.fan_out_project_ids : undefined;
  db.prepare(
    `INSERT INTO scheduled_jobs
       (id, name, project_id, kind, schedule, next_run_at, last_run_at, enabled, payload_json, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.name,
    // When fan-out is set, project_id is conceptually meaningless — we still
    // store the input for reference but the runtime ignores it.
    input.project_id ?? null,
    input.action.type,
    schedule,
    nextRun ? nextRun.toISOString() : null,
    enabled,
    JSON.stringify({ trigger: input.trigger, action: input.action, fan_out_project_ids: fanOut }),
    now,
    now,
  );
  return getJob(id)!;
}

/** Validate fan-out config: project_ids must be non-empty (when provided),
 *  must reference real projects, no duplicates. Throws on invalid. */
function validateFanOut(ids: string[] | undefined): void {
  if (!ids) return;
  if (ids.length === 0) return; // empty array = treat as not set
  if (new Set(ids).size !== ids.length) {
    throw new Error("fan_out_project_ids contains duplicates");
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).all(...ids) as { id: string }[];
  const existing = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !existing.has(id));
  if (missing.length > 0) {
    throw new Error(`fan_out_project_ids references non-existent projects: ${missing.join(", ")}`);
  }
}

export function updateJob(id: string, patch: UpdateScheduledJobInput): ScheduledJob {
  const existing = getJob(id);
  if (!existing) throw new Error(`job ${id} not found`);
  const merged = {
    name: patch.name ?? existing.name,
    project_id: patch.project_id !== undefined ? patch.project_id : existing.project_id,
    fan_out_project_ids: patch.fan_out_project_ids !== undefined ? patch.fan_out_project_ids : existing.fan_out_project_ids,
    trigger: patch.trigger ?? existing.trigger,
    action: patch.action ?? existing.action,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
  };
  validateTrigger(merged.trigger);
  const validateAgainstProjectId = merged.fan_out_project_ids?.[0] ?? merged.project_id;
  validateAction(merged.action, validateAgainstProjectId);
  validateFanOut(merged.fan_out_project_ids);
  const schedule = deriveScheduleFromTrigger(merged.trigger);
  const nextRun = merged.enabled ? computeNextRun(schedule) : null;
  // Reset state when scope changes (different secrets / dedup space) or
  // when switching to a different watch source/query.
  const fanOutChanged = JSON.stringify(merged.fan_out_project_ids ?? []) !== JSON.stringify(existing.fan_out_project_ids ?? []);
  const projectChanged = merged.project_id !== existing.project_id;
  const triggerChanged =
    merged.trigger.type !== existing.trigger.type ||
    (merged.trigger.type === "watch"
      && existing.trigger.type === "watch"
      && (merged.trigger.source !== existing.trigger.source || merged.trigger.query !== existing.trigger.query));
  const resetState = fanOutChanged || projectChanged || triggerChanged;
  const fanOut = merged.fan_out_project_ids && merged.fan_out_project_ids.length > 0 ? merged.fan_out_project_ids : undefined;
  db.prepare(
    `UPDATE scheduled_jobs
        SET name = ?, project_id = ?, kind = ?, schedule = ?, next_run_at = ?, enabled = ?,
            payload_json = ?, ${resetState ? "state_json = NULL," : ""} updated_at = ?
      WHERE id = ?`,
  ).run(
    merged.name,
    merged.project_id,
    merged.action.type,
    schedule,
    nextRun ? nextRun.toISOString() : null,
    merged.enabled ? 1 : 0,
    JSON.stringify({ trigger: merged.trigger, action: merged.action, fan_out_project_ids: fanOut }),
    nowIso(),
    id,
  );
  return getJob(id)!;
}

export function deleteJob(id: string): boolean {
  return db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id).changes > 0;
}

// ---- Triggers ---------------------------------------------------------------

interface TriggerOutcome {
  /** Items to fire the action with. Empty = nothing happens this tick. */
  items: TriggerItem[];
  /** Updated state to persist (watch triggers only). */
  newState?: JobState;
  /** Human-readable note — surfaces in the run log. */
  note?: string;
  /** Set when the trigger itself failed (e.g. token missing, API error). When
   *  present, fireJob marks the run as failed (used for ▶ button color, log
   *  prefix, etc.) — distinct from "succeeded but no items found". */
  error?: string;
}

/** A single occurrence delivered by a trigger to its action. For cron, exactly
 *  one item with empty vars. For watch, one per new external record. */
export interface TriggerItem {
  /** Stable id of the source item (used for dedup). Empty for cron. */
  source_id?: string;
  /** Placeholders available to action templates: {watch_title}, {watch_url}, etc. */
  vars: Record<string, string>;
}

async function runTrigger(job: ScheduledJob, state: JobState): Promise<TriggerOutcome> {
  if (job.trigger.type === "cron") {
    return { items: [{ vars: {} }] };
  }
  return runWatch(job, job.trigger, state);
}

// ---- Watch executors --------------------------------------------------------

async function runWatch(job: ScheduledJob, trigger: WatchTrigger, state: JobState): Promise<TriggerOutcome> {
  // Global jobs (no project_id) fall back to env secrets.
  const polledAt = nowIso();

  if (trigger.source === "github") return runGithubWatch(job, trigger, state, polledAt);
  // Jira keeps simpler id-only dedup — no commit-level distinction needed.
  return runJiraWatch(job, trigger, state, polledAt);
}

/** GitHub watch with commit-aware dedup:
 *   - First poll → baseline (record current state, no action fires)
 *   - Subsequent polls:
 *     * unseen PR id        → new PR, fetch SHA, emit
 *     * seen, updated_at same → unchanged, skip cheaply (no extra API call)
 *     * seen, updated_at diff → fetch SHA:
 *         - SHA same   → only a label/comment change, skip (still record updated_at)
 *         - SHA diff   → new commit, emit (carry watch_head_sha in vars) */
async function runGithubWatch(
  job: ScheduledJob,
  trigger: WatchTrigger,
  state: JobState,
  polledAt: string,
): Promise<TriggerOutcome> {
  let probe: GithubSearchProbe[];
  try {
    probe = await pollGithub(job.project_id, trigger.query);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { items: [], error: `watch github poll failed: ${msg}`, note: `watch github poll failed: ${msg}` };
  }

  const token = job.project_id ? getProjectSecret(job.project_id, "github_token") : (process.env.GITHUB_TOKEN ?? "");
  // Migration: legacy seen_ids → seen_prs with empty SHA (forces one re-check
  // per PR after upgrade, after which dedup works normally).
  const seen: Record<string, { sha: string; updated_at: string }> = { ...(state.seen_prs ?? {}) };
  if (!state.seen_prs && state.seen_ids) {
    for (const id of state.seen_ids) seen[id] = { sha: "", updated_at: "" };
  }

  const items: TriggerItem[] = [];
  const updatedSeen: Record<string, { sha: string; updated_at: string }> = { ...seen };
  let fetchedShas = 0;
  let unchangedSkips = 0;
  let labelOnlySkips = 0;
  let newPrs = 0;
  let newCommits = 0;

  // Two-phase loop:
  //   1) Cheap pass — partition probe into (no-change, no-token, needs-sha).
  //   2) Concurrent SHA fetch (chunks of 5) for items that need it.
  // Without batching, a 50-item baseline poll = 50 sequential GitHub API
  // calls (~7s) blocking the whole tick loop. With concurrency 5, ~1.5s.
  type Decision =
    | { kind: "skip_unchanged"; pr: GithubSearchProbe }
    | { kind: "no_token"; pr: GithubSearchProbe; prev?: { sha: string; updated_at: string } }
    | { kind: "needs_sha"; pr: GithubSearchProbe; prev?: { sha: string; updated_at: string } };
  const decisions: Decision[] = probe.map((pr) => {
    const prev = seen[pr.id];
    if (prev && prev.updated_at === pr.updated_at) return { kind: "skip_unchanged", pr };
    if (!pr.pull_request_url || !token) return { kind: "no_token", pr, prev };
    return { kind: "needs_sha", pr, prev };
  });

  const needsShaItems = decisions.filter((d): d is Extract<Decision, { kind: "needs_sha" }> => d.kind === "needs_sha");

  // Run the GitHub /pulls/{n} fetches concurrently with a small parallelism
  // cap. GitHub's secondary-rate-limit guidance is "no more than 100
  // concurrent" — 5 is well under that and avoids triggering throttling.
  const shaByPrId = new Map<string, string | null>();
  const concurrency = 5;
  for (let i = 0; i < needsShaItems.length; i += concurrency) {
    const batch = needsShaItems.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((d) => fetchPrHeadSha(token, d.pr.pull_request_url!).catch(() => null)),
    );
    batch.forEach((d, j) => shaByPrId.set(d.pr.id, results[j] ?? null));
    fetchedShas += batch.length;
  }

  for (const d of decisions) {
    if (d.kind === "skip_unchanged") {
      updatedSeen[d.pr.id] = seen[d.pr.id]!;
      unchangedSkips++;
      continue;
    }
    if (d.kind === "no_token") {
      if (!d.prev && state.baseline_recorded) {
        items.push({ source_id: d.pr.id, vars: { ...d.pr.vars, watch_head_sha: "" } });
        newPrs++;
      }
      updatedSeen[d.pr.id] = { sha: "", updated_at: d.pr.updated_at };
      continue;
    }
    // needs_sha
    const currentSha = shaByPrId.get(d.pr.id);
    if (!currentSha) {
      updatedSeen[d.pr.id] = d.prev ?? { sha: "", updated_at: d.pr.updated_at };
      continue;
    }
    if (!d.prev) {
      if (state.baseline_recorded) {
        items.push({ source_id: d.pr.id, vars: { ...d.pr.vars, watch_head_sha: currentSha } });
        newPrs++;
      }
      updatedSeen[d.pr.id] = { sha: currentSha, updated_at: d.pr.updated_at };
      continue;
    }
    if (d.prev.sha === currentSha) {
      updatedSeen[d.pr.id] = { sha: currentSha, updated_at: d.pr.updated_at };
      labelOnlySkips++;
      continue;
    }
    items.push({ source_id: d.pr.id, vars: { ...d.pr.vars, watch_head_sha: currentSha } });
    updatedSeen[d.pr.id] = { sha: currentSha, updated_at: d.pr.updated_at };
    newCommits++;
  }

  // Cap seen_prs to keep state_json bounded — drop oldest by updated_at when
  // over 500. (Typical: dozens, not hundreds.)
  const seenEntries = Object.entries(updatedSeen);
  if (seenEntries.length > 500) {
    seenEntries.sort((a, b) => (b[1].updated_at).localeCompare(a[1].updated_at));
    seenEntries.length = 500;
  }
  const cappedSeen = Object.fromEntries(seenEntries);

  // Baseline mode: just record what's there, never emit.
  if (!state.baseline_recorded) {
    return {
      items: [],
      newState: {
        seen_prs: cappedSeen,
        baseline_recorded: true,
        last_polled_at: polledAt,
        recent_results: state.recent_results,
      },
      note: `watch github: baseline recorded (${probe.length} items, ${fetchedShas} SHA fetched, no action fired)`,
    };
  }

  const total = probe.length;
  const noteSegments = [
    newPrs > 0 ? `${newPrs} new PR` : "",
    newCommits > 0 ? `${newCommits} new commit` : "",
    unchangedSkips > 0 ? `${unchangedSkips} unchanged` : "",
    labelOnlySkips > 0 ? `${labelOnlySkips} label/comment-only` : "",
  ].filter(Boolean);
  return {
    items,
    newState: {
      seen_prs: cappedSeen,
      baseline_recorded: true,
      last_polled_at: polledAt,
      recent_results: state.recent_results,
    },
    note: `watch github: ${noteSegments.join(", ") || `no change (${total} total)`} [${fetchedShas} SHA fetches]`,
  };
}

async function runJiraWatch(
  job: ScheduledJob,
  trigger: WatchTrigger,
  state: JobState,
  polledAt: string,
): Promise<TriggerOutcome> {
  let probe: { id: string; vars: Record<string, string> }[];
  try {
    probe = await pollJira(job.project_id, trigger.query);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { items: [], error: `watch jira poll failed: ${msg}`, note: `watch jira poll failed: ${msg}` };
  }
  const seen = new Set(state.seen_ids ?? []);
  const currentIds = probe.map((p) => p.id);
  const newItems = probe.filter((p) => !seen.has(p.id));
  if (!state.baseline_recorded) {
    return {
      items: [],
      newState: { seen_ids: currentIds, baseline_recorded: true, last_polled_at: polledAt, recent_results: state.recent_results },
      note: `watch jira: baseline recorded (${currentIds.length} items, no action fired)`,
    };
  }
  const merged = Array.from(new Set([...currentIds, ...(state.seen_ids ?? [])])).slice(0, 500);
  return {
    items: newItems.map((it) => ({ source_id: it.id, vars: it.vars })),
    newState: { seen_ids: merged, baseline_recorded: true, last_polled_at: polledAt, recent_results: state.recent_results },
    note: newItems.length > 0
      ? `watch jira: ${newItems.length} new item(s)`
      : `watch jira: no change (${currentIds.length} total)`,
  };
}

interface GithubSearchProbe {
  id: string;
  /** Search-API-cheap signal of any change (commit / comment / label). Used
   *  for first-pass dedup before deciding whether to fetch the head SHA. */
  updated_at: string;
  /** Path to /pulls/{number} for fetching the head SHA when needed. */
  pull_request_url?: string;
  vars: Record<string, string>;
}

async function pollGithub(projectId: string | null, query: string): Promise<GithubSearchProbe[]> {
  const token = projectId ? getProjectSecret(projectId, "github_token") : getGlobalSecret("github_token");
  if (!token) throw new Error(projectId
    ? "github_token not configured (Project Settings → Connector secrets)"
    : "github_token not configured (Admin → Connectors)");
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=updated&order=desc`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`github HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { items?: GithubSearchItem[] };
  return (json.items ?? []).map((it) => ({
    id: String(it.id),
    updated_at: String(it.updated_at ?? ""),
    pull_request_url: it.pull_request?.url,
    vars: {
      watch_id: String(it.number),
      watch_title: String(it.title ?? ""),
      watch_url: String(it.html_url ?? ""),
      watch_body: String(it.body ?? "").slice(0, 4000),
      watch_user: String(it.user?.login ?? ""),
      watch_repo: String(it.repository_url ?? "").split("/").slice(-2).join("/"),
    },
  }));
}

/** Fetch the current head commit SHA for a PR. Used by watch dedup to detect
 *  whether a PR's last update was a new commit (re-review) or just a label /
 *  comment change (skip). */
async function fetchPrHeadSha(token: string, prUrl: string): Promise<string | null> {
  const res = await fetch(prUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { head?: { sha?: string } };
  return json.head?.sha ?? null;
}

interface GithubSearchItem {
  id: number;
  number: number;
  title: string;
  body?: string;
  html_url: string;
  user?: { login: string };
  repository_url?: string;
  updated_at?: string;
  pull_request?: { url?: string };
}

async function pollJira(projectId: string | null, jql: string): Promise<{ id: string; vars: Record<string, string> }[]> {
  const get = (k: string) => projectId ? getProjectSecret(projectId, k) : getGlobalSecret(k);
  const baseUrl = get("jira_base_url").replace(/\/$/, "");
  const email = get("jira_email");
  const token = get("jira_api_token");
  if (!baseUrl || !email || !token) throw new Error(projectId
    ? "jira credentials not all configured (Project Settings → Connector secrets)"
    : "jira credentials not all configured (Admin → Connectors)");
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  const url = `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,status,assignee`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!res.ok) throw new Error(`jira HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { issues?: JiraIssue[] };
  return (json.issues ?? []).map((it) => ({
    id: it.id,
    vars: {
      watch_id: it.key,
      watch_title: String(it.fields?.summary ?? ""),
      watch_url: `${baseUrl}/browse/${it.key}`,
      watch_status: String(it.fields?.status?.name ?? ""),
      watch_assignee: String(it.fields?.assignee?.displayName ?? "(unassigned)"),
    },
  }));
}

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string };
  };
}

// ---- Action dispatchers -----------------------------------------------------

const PLACEHOLDER_RE = /\{(\w+)\}/g;
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (m, key) => (vars[key] ?? m));
}

/** Action returns a human-readable result line plus an optional URL to surface
 *  in notifications / UI (e.g. the GitHub review link or new ticket URL). */
interface ActionResult {
  result: string;
  /** Externally visible URL — review on github, ticket in app, etc. */
  url?: string;
  /** When true, push a Telegram notification (for actions that produce
   *  noteworthy output the user should see — like a posted PR review). */
  notify?: boolean;
  /** Structured payload (e.g. ReviewerOutput for review_pr) persisted to
   *  job_runs.details_json so the UI can render the full content without
   *  hitting an external service. Capped server-side at ~16KB. */
  details?: unknown;
}

async function runAction(
  job: ScheduledJob,
  action: ScheduledJobAction,
  item: TriggerItem,
): Promise<ActionResult> {
  if (action.type === "create_ticket") return { result: await runCreateTicket(job, action, item) };
  if (action.type === "telegram_digest") return { result: await runTelegramDigest(job, action) };
  if (action.type === "scheduler_mode") {
    setSchedulerMode(action.mode);
    return { result: `scheduler mode → ${action.mode}` };
  }
  if (action.type === "review_pr") return runReviewPr(job, action, item);
  if (action.type === "telegram_message") return runTelegramMessage(job, action, item);
  if (action.type === "webhook") return runWebhook(job, action, item);
  if (action.type === "github_op") return runGithubOp(job, action, item);
  return { result: "unknown action" };
}

async function runCreateTicket(job: ScheduledJob, action: CreateTicketAction, item: TriggerItem): Promise<string> {
  if (!job.project_id) throw new Error("create_ticket: project_id required");
  const project = loadProjectWithRepos(job.project_id);
  if (!project) throw new Error(`project ${job.project_id} not found`);

  const title = renderTemplate(action.title, item.vars).slice(0, 200);
  const body = renderTemplate(action.body, item.vars);
  const ticketId = nanoid(10);
  const now = nowIso();
  const ticketKey = allocateTicketKey(job.project_id);
  const triageNote = item.source_id
    ? `Auto-created by watch job "${job.name}" (source: ${item.source_id}).`
    : `Auto-created by scheduled job "${job.name}".`;
  db.prepare(
    `INSERT INTO tickets
       (id, project_id, ticket_key, title, body, status, priority, repos_touched, depends_on, triage_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbox', ?, '[]', '[]', ?, ?, ?)`,
  ).run(ticketId, job.project_id, ticketKey, title, body, action.priority ?? "P2", triageNote, now, now);

  if (!action.auto_start) return `created ticket ${ticketKey} (inbox)`;
  const ticket = loadTicket(ticketId);
  if (!ticket) throw new Error("ticket lookup failed after insert");
  const runId = await startRun({ project, ticket });
  return `created ticket ${ticketKey}, started run ${runId.slice(0, 8)}`;
}

interface ReviewerSpec {
  name: string;
  system_prompt: string;
  model: string | null;
  allowed_tools: string[] | null;
}

/** Resolve which reviewer to use based on whether the job is project- or
 *  global-scoped. Project: pull from project.agents. Global: pull from the
 *  admin Skill template library. */
async function resolveReviewer(job: ScheduledJob, action: ReviewPrAction): Promise<{ ok: true; reviewer: ReviewerSpec } | { ok: false; message: string }> {
  if (job.project_id) {
    const project = loadProjectWithRepos(job.project_id);
    if (!project) return { ok: false, message: `project ${job.project_id} not found` };
    const a = action.agent_name
      ? project.agents.find((x) => x.name === action.agent_name)
      : project.agents.find((x) => x.role === "reviewer");
    if (!a) return { ok: false, message: "no reviewer agent in project (set action.agent_name or add a reviewer-role agent)" };
    return { ok: true, reviewer: { name: a.name, system_prompt: a.system_prompt, model: a.model, allowed_tools: a.allowed_tools } };
  }
  // Global: load from admin Skill templates.
  const { getAgentTemplate } = await import("./agentTemplates.js");
  const key = action.agent_template_key ?? "reviewer";
  const tpl = getAgentTemplate(key);
  if (!tpl) return { ok: false, message: `admin Skill template "${key}" not found (Admin → Templates → Skill templates)` };
  if (tpl.role !== "reviewer") return { ok: false, message: `template "${key}" has role="${tpl.role}", expected "reviewer"` };
  return { ok: true, reviewer: { name: tpl.name, system_prompt: tpl.system_prompt, model: tpl.model, allowed_tools: tpl.allowed_tools } };
}

/** Resolve github_token for project- or global-scoped jobs.
 *    project: project_secrets → global_secrets → env (chained inside getProjectSecret)
 *    global:  global_secrets → env (chained inside getGlobalSecret) */
function resolveGithubToken(projectId: string | null): string {
  return projectId ? getProjectSecret(projectId, "github_token") : getGlobalSecret("github_token");
}

async function runReviewPr(job: ScheduledJob, action: ReviewPrAction, item: TriggerItem): Promise<ActionResult> {
  const token = resolveGithubToken(job.project_id);
  if (!token) {
    return {
      result: job.project_id
        ? "review_pr: github_token not configured (project secrets)"
        : "review_pr: GITHUB_TOKEN env var not set (global scope needs env fallback)",
    };
  }

  // Resolve target PR — placeholders default to the github watch trigger.
  const repoStr = renderTemplate(action.repo_template ?? "{watch_repo}", item.vars).trim();
  const numberStr = renderTemplate(action.pr_number_template ?? "{watch_id}", item.vars).trim();
  const repoParts = repoStr.split("/");
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    throw new Error(`review_pr: cannot resolve repo from "${repoStr}" (need owner/name; check watch_repo placeholder)`);
  }
  const number = Number(numberStr);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`review_pr: invalid PR number "${numberStr}"`);
  }
  const [owner, name] = repoParts as [string, string];

  // Resolve reviewer agent.
  const reviewerResolved = await resolveReviewer(job, action);
  if (!reviewerResolved.ok) return { result: `review_pr: ${reviewerResolved.message}` };
  const reviewer = reviewerResolved.reviewer;

  // Fetch unified diff.
  const diffRes = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${number}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.diff",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!diffRes.ok) {
    return { result: `review_pr: failed to fetch diff (HTTP ${diffRes.status}): ${(await diffRes.text()).slice(0, 200)}` };
  }
  const diff = await diffRes.text();
  const cappedDiff = diff.length > 120_000 ? diff.slice(0, 120_000) + "\n\n[... diff truncated]" : diff;

  // Prompt is in Czech (user-facing comments will be in Czech), and explicitly
  // demands ONLY inline per-line comments — no summary paragraph, no overall
  // verdict, no project-level commentary. Each comment must be short and end
  // with a concrete fix suggestion ("opravit jako: …" / "místo X dej Y").
  const focus = action.focus_mode ?? "comprehensive";
  const focusInstructions = focus === "critical_only"
    ? `**Režim: jen kritické věci.** Komentuj jen:
   - Funkční bugy (špatná logika, off-by-one, race conditions, chybějící null check)
   - Security (injection, auth bypass, secret v kódu)
   - Performance regrese (N+1, unbounded loop, blokující I/O v hot path)
   - Typo v user-facing stringu / error message / log
   **Vynech:** styl, formátování, naming, dokumentaci, "zvažte". Nic co není reálný bug.`
    : `**Režim: vše co stojí za zmínku** — bugy, security, perf, ale i konkrétní zlepšení.`;

  const prompt = [
    `# Code review`,
    ``,
    `**PR:** ${item.vars.watch_url || `https://github.com/${owner}/${name}/pull/${number}`}`,
    `**Repo:** ${owner}/${name}`,
    ``,
    `## Popis PR`,
    item.vars.watch_body || "(empty)",
    ``,
    `## Diff`,
    "```diff",
    cappedDiff,
    "```",
    ``,
    `## Tvůj úkol`,
    ``,
    focusInstructions,
    ``,
    `**Výstup: jen inline komentáře k řádkům.** Žádné shrnutí, žádný úvod, žádný odstavec o projektu jako celku.`,
    ``,
    `Pravidla pro každý komentář:`,
    `- **Česky.**`,
    `- **Krátký** (1–2 věty, max 3).`,
    `- **Konkrétní** — kde je problém, proč, a JAK to opravit. Ideálně rovnou code-block s opraveným kódem.`,
    `- **Lidsky** — žádný corporate jazyk. Říkej co bys řekl kolegovi v code review.`,
    `- Komentuj **jen reálně změněné řádky** v diffu (žádné vymýšlení).`,
    ``,
    `Pokud PR žádný problém nemá → vrať prázdné \`comments: []\`. Žádné "vypadá dobře" zprávy.`,
    ``,
    `Vrať **jen jeden JSON objekt** na posledním řádku odpovědi:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "comments": [`,
    `    {`,
    `      "path": "src/foo.ts",`,
    `      "line": 42,                       // řádek v NOVÉ verzi souboru (pravá strana diffu)`,
    `      "side": "RIGHT",                  // "RIGHT" = přidaný/změněný řádek (default), "LEFT" = smazaný`,
    `      "severity": "blocker" | "major" | "minor",`,
    `      "body": "Krátký popis problému. Oprava: <konkrétně jak>. Ideálně:\\n\\n\`\`\`<lang>\\n<opravený kód>\\n\`\`\`"`,
    `    }`,
    `  ]`,
    `}`,
    `\`\`\``,
  ].join("\n");

  let result;
  try {
    result = await runAgentOneShot(
      {
        system_prompt: reviewer.system_prompt,
        model: reviewer.model,
        allowed_tools: reviewer.allowed_tools,
      },
      prompt,
    );
  } catch (e: unknown) {
    return { result: `review_pr: reviewer failed — ${e instanceof Error ? e.message : String(e)}` };
  }
  recordCost({
    source: "review_pr",
    cost_usd: extractCostFromStdout(result.stdout),
    project_id: job.project_id ?? null,
  });

  // Parse the structured response. extractJsonWithFallback walks the verbose
  // stream-json transcript and extracts the JSON blob from the final assistant
  // text — robust against rate-limit prefix events. The new schema is just
  // { comments[] } — no summary, no verdict.
  let review: ReviewerOutput;
  try {
    const parsed = extractJsonWithFallback<Record<string, unknown>>(result.stdout);
    if (!parsed || typeof parsed !== "object") throw new Error("agent did not return parseable JSON");
    const obj = parsed;
    review = {
      comments: Array.isArray(obj.comments)
        ? (obj.comments as Record<string, unknown>[])
            .filter((c) => typeof c.path === "string" && Number.isInteger(c.line) && typeof c.body === "string")
            .map((c): InlineReviewComment => ({
              path: c.path as string,
              line: c.line as number,
              side: c.side === "LEFT" ? "LEFT" : "RIGHT",
              severity: (REVIEW_SEVERITIES as readonly string[]).includes(c.severity as string)
                ? (c.severity as ReviewSeverity)
                : "minor",
              body: c.body as string,
            }))
        : [],
    };
  } catch (e: unknown) {
    return { result: `review_pr: failed to parse reviewer JSON — ${e instanceof Error ? e.message : String(e)}; raw stdout (first 200 chars): ${result.stdout.slice(0, 200)}` };
  }

  if (action.post_comment === false) {
    return {
      result: `review_pr: ran ${reviewer.name} on ${owner}/${name}#${number} (dry run, ${review.comments.length} inline)`,
      details: { mode: "dry_run", repo: `${owner}/${name}`, pr: number, review },
    };
  }

  // Skip API call when the reviewer found nothing — no point posting an
  // empty review. Still log the run so the user sees "nothing to flag".
  if (review.comments.length === 0) {
    return {
      result: `review_pr: ${reviewer.name} on ${owner}/${name}#${number} — bez připomínek (nic nepostováno)`,
      details: { mode: "no_comments", repo: `${owner}/${name}`, pr: number, review },
    };
  }

  // Prefer the head SHA the watch trigger already fetched (no extra API call).
  // Fall back to a fresh fetch if it wasn't carried (e.g. cron-triggered review_pr).
  let headSha = item.vars.watch_head_sha;
  if (!headSha) {
    const meta = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!meta.ok) return { result: `review_pr: failed to fetch PR metadata for commit_id (HTTP ${meta.status})` };
    const metaJson = await meta.json() as { head?: { sha?: string } };
    headSha = metaJson.head?.sha ?? "";
  }
  if (!headSha) return { result: `review_pr: PR has no head commit SHA, cannot attach inline comments` };

  // Severity emoji prefix lets the reader quickly skim the noise level
  // without us posting a separate severity column.
  const sevEmoji: Record<ReviewSeverity, string> = {
    blocker: "🔴",
    major: "🟠",
    minor: "🟡",
  };
  // No top-level body = no project-wide summary on the PR. Just inline
  // comments wrapped in a COMMENT review (never REQUEST_CHANGES — that's
  // a formal block that confuses humans seeing bot reviews).
  const reviewPayload = {
    commit_id: headSha,
    body: "",
    event: "COMMENT",
    comments: review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: `${sevEmoji[c.severity]} ${c.body}`,
    })),
  };

  const postRes = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${number}/reviews`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reviewPayload),
  });
  if (!postRes.ok) {
    const errBody = (await postRes.text()).slice(0, 400);
    // Common cause: line number doesn't fall on the diff. Fall back to a
    // top-level issue comment so the review isn't lost — better degraded
    // than dropped.
    if (postRes.status === 422 && review.comments.length > 0) {
      // Inline anchoring failed — fall back to a single issue comment listing
      // each comment with its file:line prefix, still in Czech, no summary.
      const fallback = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${number}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: review.comments.map((c) => `${sevEmoji[c.severity]} \`${c.path}:${c.line}\`\n${c.body}`).join("\n\n---\n\n"),
        }),
      });
      if (fallback.ok) {
        const fallbackJson = await fallback.json() as { html_url?: string };
        return {
          result: `review_pr: inline anchoring failed (HTTP 422), posted as fallback issue comment on ${owner}/${name}#${number}`,
          url: fallbackJson.html_url,
          notify: true,
        };
      }
    }
    return { result: `review_pr: review generated but post failed (HTTP ${postRes.status}): ${errBody}` };
  }
  const posted = await postRes.json() as { html_url?: string };
  return {
    result: `review_pr: ${review.comments.length} inline komentářů na ${owner}/${name}#${number} (${focus})`,
    url: posted.html_url,
    notify: true,
    details: { mode: "posted", repo: `${owner}/${name}`, pr: number, review },
  };
}

/** Render placeholders {watch_*}, {ticket_key}, etc. against item.vars +
 *  built-in fallbacks. Used by webhook / telegram_message / github_op. */
function renderItemVars(template: string, item: TriggerItem): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => item.vars[key] ?? m);
}

async function runTelegramMessage(_job: ScheduledJob, action: TelegramMessageAction, item: TriggerItem): Promise<ActionResult> {
  const text = renderItemVars(action.text, item);
  const chatId = action.chat_id ?? (TELEGRAM_OUTPUT_CHAT_ID ? Number(TELEGRAM_OUTPUT_CHAT_ID) : 0);
  if (!chatId) {
    return { result: "telegram_message: no chat_id (set action.chat_id or TELEGRAM_OUTPUT_CHAT_ID)" };
  }
  try {
    const sent = await sendTelegramMessage(chatId, text);
    return sent
      ? { result: `telegram_message: sent to chat ${chatId} (${text.length} chars)`, notify: false }
      : { result: "telegram_message: telegram disabled (no TELEGRAM_BOT_TOKEN)" };
  } catch (e: unknown) {
    return { result: `telegram_message: failed — ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function runWebhook(_job: ScheduledJob, action: WebhookAction, item: TriggerItem): Promise<ActionResult> {
  const url = renderItemVars(action.url, item);
  const body = renderItemVars(action.body_template, item);
  const method = action.method ?? "POST";
  const contentType = action.content_type ?? "application/json";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ...(action.headers ?? {}),
  };
  try {
    const res = await fetch(url, { method, headers, body });
    const ok = res.status >= 200 && res.status < 300;
    const respBody = (await res.text()).slice(0, 500);
    return {
      result: ok
        ? `webhook: ${method} ${url} → HTTP ${res.status}`
        : `webhook: ${method} ${url} failed — HTTP ${res.status}: ${respBody.slice(0, 100)}`,
      url,
      notify: ok,
    };
  } catch (e: unknown) {
    return { result: `webhook: ${method} ${url} failed — ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function runGithubOp(job: ScheduledJob, action: GithubOpAction, item: TriggerItem): Promise<ActionResult> {
  const token = job.project_id
    ? getProjectSecret(job.project_id, "github_token")
    : getGlobalSecret("github_token");
  if (!token) {
    return { result: "github_op: github_token not configured" };
  }
  const op = action.github;
  const repo = renderItemVars(op.repo, item).trim();
  const repoParts = repo.split("/");
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    return { result: `github_op: invalid repo "${repo}" (need owner/name)` };
  }
  const [owner, name] = repoParts as [string, string];
  const apiHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // Each op has a distinct REST endpoint + body shape. Keep the dispatcher
  // explicit rather than abstract — different verbs, different fields.
  let url: string;
  let method: string;
  let body: string | undefined;
  let preview: string;
  if (op.op === "issue_comment") {
    const num = renderItemVars(op.issue_number, item);
    url = `https://api.github.com/repos/${owner}/${name}/issues/${num}/comments`;
    method = "POST";
    body = JSON.stringify({ body: renderItemVars(op.body, item) });
    preview = `comment on ${owner}/${name}#${num}`;
  } else if (op.op === "set_labels") {
    const num = renderItemVars(op.issue_number, item);
    url = `https://api.github.com/repos/${owner}/${name}/issues/${num}/labels`;
    method = "PUT";
    body = JSON.stringify({ labels: op.labels });
    preview = `labels(${op.labels.join(",")}) on ${owner}/${name}#${num}`;
  } else if (op.op === "close_issue") {
    const num = renderItemVars(op.issue_number, item);
    url = `https://api.github.com/repos/${owner}/${name}/issues/${num}`;
    method = "PATCH";
    body = JSON.stringify({ state: "closed" });
    preview = `close ${owner}/${name}#${num}`;
  } else if (op.op === "assign") {
    const num = renderItemVars(op.issue_number, item);
    url = `https://api.github.com/repos/${owner}/${name}/issues/${num}/assignees`;
    method = "POST";
    body = JSON.stringify({ assignees: op.assignees });
    preview = `assign(${op.assignees.join(",")}) on ${owner}/${name}#${num}`;
  } else if (op.op === "request_reviewers") {
    const num = renderItemVars(op.pr_number, item);
    url = `https://api.github.com/repos/${owner}/${name}/pulls/${num}/requested_reviewers`;
    method = "POST";
    body = JSON.stringify({
      reviewers: op.reviewers,
      ...(op.team_reviewers ? { team_reviewers: op.team_reviewers } : {}),
    });
    preview = `request reviewers(${op.reviewers.join(",")}) on ${owner}/${name}#${num}`;
  } else if (op.op === "dispatch_workflow") {
    url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${op.workflow_id}/dispatches`;
    method = "POST";
    body = JSON.stringify({
      ref: op.ref ?? "main",
      ...(op.inputs ? { inputs: op.inputs } : {}),
    });
    preview = `dispatch workflow ${op.workflow_id}@${op.ref ?? "main"}`;
  } else {
    return { result: `github_op: unknown op "${(op as { op: string }).op}"` };
  }

  try {
    const res = await fetch(url, { method, headers: apiHeaders, body });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      const errBody = (await res.text()).slice(0, 200);
      return { result: `github_op: ${preview} failed — HTTP ${res.status}: ${errBody}` };
    }
    let postedUrl: string | undefined;
    try {
      const json = await res.json() as { html_url?: string };
      postedUrl = json.html_url;
    } catch { /* dispatch_workflow returns 204 with no body */ }
    return {
      result: `github_op: ${preview} (HTTP ${res.status})`,
      url: postedUrl,
      notify: true,
    };
  } catch (e: unknown) {
    return { result: `github_op: ${preview} failed — ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function runTelegramDigest(job: ScheduledJob, action: TelegramDigestAction): Promise<string> {
  const lookbackHours = action.lookback_hours ?? 24;
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const projectFilter = job.project_id ? "AND project_id = ?" : "";
  const projectArgs: unknown[] = job.project_id ? [job.project_id] : [];

  const stats = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
       SUM(CASE WHEN status IN ('running','pending','awaiting_approval') THEN 1 ELSE 0 END) AS active,
       COALESCE(SUM(total_cost_usd), 0) AS cost
     FROM runs WHERE created_at >= ? ${projectFilter}`,
  ).get(since, ...projectArgs) as {
    total: number; succeeded: number; failed: number; cancelled: number; active: number; cost: number;
  };
  const projectName = job.project_id
    ? ((db.prepare("SELECT name FROM projects WHERE id = ?").get(job.project_id) as { name?: string } | undefined)?.name ?? job.project_id)
    : "all projects";
  const lines = [
    `📊 *Digest — ${projectName}* (last ${lookbackHours}h)`,
    ``,
    `Runs: *${stats.total}* — ${stats.succeeded} ✅ / ${stats.failed} ❌ / ${stats.cancelled} 🛑 / ${stats.active} 🏃`,
    `Spend: *$${Number(stats.cost ?? 0).toFixed(2)}*`,
  ];
  const activeRows = db.prepare(
    `SELECT t.ticket_key, t.title, r.status, r.total_cost_usd
       FROM runs r LEFT JOIN tickets t ON t.id = r.ticket_id
      WHERE r.status IN ('running','pending','awaiting_approval')
        ${job.project_id ? "AND r.project_id = ?" : ""}
      ORDER BY r.created_at DESC LIMIT 5`,
  ).all(...projectArgs) as { ticket_key: string | null; title: string; status: string; total_cost_usd: number | null }[];
  if (activeRows.length > 0) {
    lines.push(``, `*Active:*`);
    for (const r of activeRows) {
      const cost = r.total_cost_usd ? `$${r.total_cost_usd.toFixed(2)}` : "$?";
      lines.push(`• ${r.ticket_key ?? "?"} — ${r.status} (${cost}) _${(r.title ?? "").slice(0, 60)}_`);
    }
  }
  const message = lines.join("\n");
  const chatId = action.chat_id ?? (TELEGRAM_OUTPUT_CHAT_ID ? Number(TELEGRAM_OUTPUT_CHAT_ID) : 0);
  if (!chatId) return "digest computed but no chat_id (set action.chat_id or TELEGRAM_OUTPUT_CHAT_ID)";
  const sent = await sendTelegramMessage(chatId, message);
  return sent ? `pushed digest to chat ${chatId}` : "telegram disabled — digest not sent";
}

// ---- Top-level fire ---------------------------------------------------------

interface FireOnceOutput {
  /** Human-readable result line (or "error: ..." prefix on failure). */
  resultNote: string;
  /** Updated sub-state to persist for this scope. */
  newState: JobState;
  /** Recent-results entries produced (already tagged with project_id when
   *  fan-out). The orchestrator merges them into the outer state's ring. */
  recentEntries: { at: string; summary: string; url?: string; project_id?: string }[];
}

/** Run trigger + actions for a SINGLE scope (single project_id, single
 *  state space). Returns updated sub-state plus recent-result entries.
 *  Pure-ish: doesn't write to DB or send telegrams — the caller decides how
 *  to merge results across fan-out branches. */
async function fireOnce(
  job: ScheduledJob,
  effectiveProjectId: string | null,
  inState: JobState,
): Promise<FireOnceOutput> {
  // Job seen by trigger/action carries the effective project_id (so
  // pollGithub, runReviewPr etc. resolve secrets / agents correctly).
  const effectiveJob: ScheduledJob = { ...job, project_id: effectiveProjectId };
  let workingState: JobState = { ...inState };
  const recentEntries: FireOnceOutput["recentEntries"] = [];
  let resultNote: string;
  try {
    const triggerResult = await runTrigger(effectiveJob, inState);
    if (triggerResult.newState) workingState = { ...workingState, ...triggerResult.newState };

    if (triggerResult.error) {
      resultNote = `error: ${triggerResult.error}`;
      recordJobRun({
        job: effectiveJob,
        effective_project_id: effectiveProjectId,
        ok: false,
        notable: true,
        summary: triggerResult.error,
      });
    } else if (triggerResult.items.length === 0) {
      resultNote = triggerResult.note ?? "no items";
    } else {
      const subResults: string[] = [];
      for (const item of triggerResult.items) {
        let actionResult: ActionResult;
        try {
          actionResult = await runAction(effectiveJob, effectiveJob.action, item);
        } catch (e: unknown) {
          actionResult = { result: `error: ${e instanceof Error ? e.message : String(e)}` };
        }
        subResults.push(actionResult.result);
        const isError = isErrorResult(actionResult.result);
        recentEntries.push({
          at: nowIso(),
          summary: actionResult.result,
          url: actionResult.url,
          project_id: effectiveProjectId ?? undefined,
        });
        recordJobRun({
          job: effectiveJob,
          effective_project_id: effectiveProjectId,
          ok: !isError,
          notable: isError || !!actionResult.notify,
          summary: actionResult.result,
          url: actionResult.url,
          details: actionResult.details,
        });

        if (actionResult.notify && TELEGRAM_OUTPUT_CHAT_ID) {
          // Tag notification with project context so users can see which
          // project a fan-out fire belongs to.
          const projTag = effectiveProjectId
            ? (() => {
              const row = db.prepare("SELECT key_prefix, name FROM projects WHERE id = ?").get(effectiveProjectId) as { key_prefix?: string; name?: string } | undefined;
              return row ? ` · ${row.key_prefix ?? row.name}` : "";
            })()
            : "";
          const lines = [
            `🔎 *${job.name}*${projTag}`,
            actionResult.result,
            actionResult.url ? actionResult.url : "",
          ].filter(Boolean).join("\n");
          await sendTelegramMessage(Number(TELEGRAM_OUTPUT_CHAT_ID), lines).catch((e) => {
            console.error(`[jobs] telegram notify failed:`, e);
          });
        }
      }
      resultNote = `${triggerResult.note ? triggerResult.note + " — " : ""}${subResults.length} action(s): ${subResults.join("; ").slice(0, 200)}`;
    }
  } catch (e: unknown) {
    resultNote = `error: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[jobs] ${job.id} ${job.name} (project=${effectiveProjectId}) failed:`, e);
  }
  return { resultNote, newState: workingState, recentEntries };
}

/** Top-level fire: dispatches single-scope or fan-out execution, merges
 *  recent_results into the outer state ring buffer, and advances next_run_at.
 *  One-shot @once jobs auto-disable after firing. */
async function fireJob(job: ScheduledJob, rawState: JobState): Promise<string> {
  let resultNote: string;
  let outerState: JobState = { ...rawState };

  const fanOut = job.fan_out_project_ids && job.fan_out_project_ids.length > 0
    ? job.fan_out_project_ids
    : null;

  if (fanOut) {
    // Fan-out: iterate projects, each with its own sub-state. Recent results
    // bubble up to the outer ring buffer (capped) so the UI shows a single
    // unified history with project tags.
    // Pre-fetch all key_prefix labels in one query — avoids N+1 lookup per
    // sub-execution for the result-note prefix.
    const placeholders = fanOut.map(() => "?").join(",");
    const labelRows = db.prepare(
      `SELECT id, key_prefix FROM projects WHERE id IN (${placeholders})`,
    ).all(...fanOut) as { id: string; key_prefix: string }[];
    const labelByPid = new Map(labelRows.map((r) => [r.id, r.key_prefix]));

    const subStates = { ...(rawState.per_project ?? {}) };
    const allRecent: FireOnceOutput["recentEntries"] = [];
    const subNotes: string[] = [];
    for (const pid of fanOut) {
      const subIn = subStates[pid] ?? {};
      const out = await fireOnce(job, pid, subIn);
      subStates[pid] = out.newState;
      allRecent.push(...out.recentEntries);
      const projLabel = labelByPid.get(pid) ?? pid.slice(0, 6);
      subNotes.push(`[${projLabel}] ${out.resultNote}`);
    }
    outerState = {
      ...outerState,
      per_project: subStates,
      recent_results: [...allRecent, ...(outerState.recent_results ?? [])].slice(0, MAX_RECENT_RESULTS),
    };
    // Aggregate result note: error if any sub failed, else summarized.
    const anyError = subNotes.some((s) => s.includes("] error:"));
    resultNote = anyError
      ? `error: fan-out had failures — ${subNotes.join(" | ").slice(0, 300)}`
      : `fan-out (${fanOut.length} projects) — ${subNotes.join(" | ").slice(0, 300)}`;
  } else {
    // Single scope (project or default).
    const out = await fireOnce(job, job.project_id, rawState);
    outerState = {
      ...out.newState,
      recent_results: [...out.recentEntries, ...(rawState.recent_results ?? [])].slice(0, MAX_RECENT_RESULTS),
    };
    resultNote = out.resultNote;
  }

  writeState(job.id, outerState);

  const schedule = deriveScheduleFromTrigger(job.trigger);
  const isOneShot = schedule.trim().startsWith("@once:");
  let next: Date | null = null;
  if (!isOneShot) {
    try { next = computeNextRun(schedule); }
    catch (e) { console.error(`[jobs] ${job.id} compute next failed:`, e); }
  }
  const now = nowIso();
  db.prepare(
    `UPDATE scheduled_jobs
        SET last_run_at = ?, next_run_at = ?, enabled = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    now,
    next ? next.toISOString() : null,
    isOneShot ? 0 : (job.enabled ? 1 : 0),
    now,
    job.id,
  );
  return resultNote;
}

/** In-memory lock — prevents `fireJobNow` and `tick()` from running the same
 *  job concurrently (which would race on state writes and could fire duplicate
 *  reviews / tickets). Server-process scoped; not for multi-instance setups. */
const firingJobs = new Set<string>();

export async function fireJobNow(id: string): Promise<{ ok: boolean; result: string }> {
  if (firingJobs.has(id)) {
    return { ok: false, result: "error: job is already running" };
  }
  firingJobs.add(id);
  try {
    const r = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as RawJobRow | undefined;
    if (!r) return { ok: false, result: "not found" };
    const result = await fireJob(rowToJob(r), readState(r));
    return { ok: !result.startsWith("error:"), result };
  } finally {
    firingJobs.delete(id);
  }
}

/** Run a one-off review_pr on a specific PR, bypassing the watch trigger.
 *  Useful for ad-hoc reviews when the user isn't review-requested or the
 *  query doesn't match cleanly. Result is logged to job_runs like any job
 *  fire (with project_id=null since this is a one-off). */
export async function reviewPrAdHoc(args: {
  repo: string;
  pr_number: number;
  project_id: string | null;
  agent_template_key?: string;
  agent_name?: string;
  focus_mode?: "comprehensive" | "critical_only";
  post_comment?: boolean;
}): Promise<{ ok: boolean; result: string; details?: unknown }> {
  // Synthesize a virtual job + item so we can reuse runReviewPr unchanged.
  const fakeJob: ScheduledJob = {
    id: "ad-hoc",
    name: `ad-hoc review ${args.repo}#${args.pr_number}`,
    project_id: args.project_id,
    trigger: { type: "cron", schedule: "0 0 1 1 *" },
    action: {
      type: "review_pr",
      post_comment: args.post_comment ?? true,
      focus_mode: args.focus_mode ?? "comprehensive",
      agent_template_key: args.agent_template_key,
      agent_name: args.agent_name,
    },
    next_run_at: null,
    last_run_at: null,
    enabled: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const fakeItem: TriggerItem = {
    source_id: `${args.repo}#${args.pr_number}`,
    vars: {
      watch_repo: args.repo,
      watch_id: String(args.pr_number),
      watch_url: `https://github.com/${args.repo}/pull/${args.pr_number}`,
      watch_title: "",
      watch_body: "",
      watch_user: "",
      watch_head_sha: "",
    },
  };

  const out = await runReviewPr(fakeJob, fakeJob.action as ReviewPrAction, fakeItem);
  const ok = !isErrorResult(out.result);

  // Persist as a job_run so it shows up in the activity feed + bell.
  recordJobRun({
    job: fakeJob,
    effective_project_id: args.project_id,
    ok,
    notable: true,
    summary: out.result,
    url: out.url,
    details: out.details,
  });

  return { ok, result: out.result, details: out.details };
}

// ---- Tick loop --------------------------------------------------------------

async function tick(): Promise<void> {
  const now = nowIso();
  const due = db.prepare(
    `SELECT * FROM scheduled_jobs
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
  ).all(now) as RawJobRow[];

  for (const r of due) {
    // Atomic DB claim via next_run_at flip + in-memory lock to coordinate
    // with fireJobNow() (which doesn't read next_run_at).
    const claimed = db.prepare(
      `UPDATE scheduled_jobs SET next_run_at = NULL WHERE id = ? AND next_run_at = ?`,
    ).run(r.id, r.next_run_at);
    if (claimed.changes === 0) continue;
    if (firingJobs.has(r.id)) continue; // run-now in progress; skip this tick
    firingJobs.add(r.id);
    try {
      const job = rowToJob(r);
      const state = readState(r);
      const result = await fireJob(job, state);
      console.log(`[jobs] fired ${job.id} "${job.name}": ${result}`);
    } finally {
      firingJobs.delete(r.id);
    }
  }
}

/** Trim job_runs to keep DB lean. Watch jobs at 30s ticks can produce
 *  thousands of rows/day; without cleanup the table + details_json grow
 *  unbounded. Default retention: 90 days. */
export function pruneOldJobRuns(retentionDays = 90): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  const r = db.prepare("DELETE FROM job_runs WHERE fired_at < ?").run(cutoff);
  if (r.changes > 0) console.log(`[jobs] pruned ${r.changes} old job_runs (older than ${retentionDays}d)`);
  return r.changes;
}

export function startScheduledJobs(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void tick().catch((e) => console.error("[jobs] tick error", e));
  }, TICK_MS);
  tickTimer.unref?.();
  void tick().catch((e) => console.error("[jobs] startup tick error", e));
  console.log("[jobs] scheduled jobs runner started (tick every 30s).");
}
