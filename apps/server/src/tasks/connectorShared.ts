/**
 * Shared utilities for connector tasks (github, jira, ssh, telegram).
 *
 * Each connector exposes the same {action[]} shape with per-action triggers
 * and placeholder substitution; this module factors out:
 *
 *   - Trigger type + shouldFire predicate
 *   - Placeholder regex + buildVars(ctx) + render(template, vars)
 *   - aggregateResults helper for the after-loop verdict construction
 *
 * Adding a new connector should require zero copies of any of the above.
 */

import type { TaskContext, TaskVerdict } from "./types.js";

// ---- Triggers ---------------------------------------------------------------

export const TRIGGER_VALUES = ["always", "success", "failure"] as const;
export type Trigger = (typeof TRIGGER_VALUES)[number];

export function isTrigger(v: unknown): v is Trigger {
  return typeof v === "string" && (TRIGGER_VALUES as readonly string[]).includes(v);
}

export function shouldFire(trigger: Trigger, wasFailure: boolean): boolean {
  if (trigger === "always") return true;
  if (trigger === "success") return !wasFailure;
  return wasFailure;
}

// ---- Placeholders -----------------------------------------------------------

const PLACEHOLDER_RE = /\{(ticket_key|ticket_title|project_name|run_id|verdict_summary|verdict_status)\}/g;

export type PlaceholderVars = Record<
  "ticket_key" | "ticket_title" | "project_name" | "run_id" | "verdict_summary" | "verdict_status",
  string
>;

/** Build the standard placeholder map from the task's run context. */
export function buildVars(ctx: TaskContext): PlaceholderVars {
  const verdictSummary = (ctx.lastVerdict as { summary?: string } | null)?.summary ?? "(no previous verdict)";
  const verdictStatus = ctx.lastWasFailure ? "❌ failed" : "✅ ok";
  return {
    ticket_key: ctx.ticket.ticket_key ?? ctx.ticket.id.slice(0, 6),
    ticket_title: ctx.ticket.title,
    project_name: ctx.project.name,
    run_id: ctx.runId,
    verdict_summary: String(verdictSummary),
    verdict_status: verdictStatus,
  };
}

/** Substitute placeholders. Unknown placeholders pass through unchanged. */
export function render(template: string, vars: PlaceholderVars): string {
  return template.replace(PLACEHOLDER_RE, (_, key) => vars[key as keyof PlaceholderVars] ?? "");
}

// ---- Result aggregation -----------------------------------------------------

export interface ActionResult {
  ok: boolean;
  /** Short label e.g. "comment on PROJ-1" — used in summary + issues. */
  preview: string;
  /** HTTP status, exit code, or 0 when N/A. */
  status?: number;
  /** Per-action body / stderr tail, sliced to ~800 chars. */
  body: string;
}

/** Build a TaskVerdict from a list of per-action results. Used by every
 *  connector once it has run its eligible actions. */
export function aggregateResults(args: {
  label: string;
  results: ActionResult[];
  totalConfigured: number;
}): TaskVerdict {
  const { label, results, totalConfigured } = args;
  const okCount = results.filter((r) => r.ok).length;
  const allOk = okCount === results.length;
  const skipped = totalConfigured - results.length;

  const issues = results
    .filter((r) => !r.ok)
    .map((r) => {
      const status = r.status ? `${labelStatus(r.status)} ` : "";
      return `${r.preview}: ${status}${r.body.slice(0, 150)}`.trim();
    });

  const details = results
    .map((r) => {
      const status = r.status ? ` (${labelStatus(r.status)})` : "";
      return `[${r.ok ? "ok" : "FAIL"}] ${r.preview}${status}\n${r.body.slice(0, 800)}`;
    })
    .join("\n\n")
    .slice(0, 4096);

  return {
    ok: allOk,
    summary: allOk
      ? `${label}: ${okCount} action(s) ok${skipped ? ` (${skipped} skipped by trigger)` : ""}`
      : `${label}: ${okCount}/${results.length} action(s) ok`,
    issues,
    details,
  };
}

function labelStatus(status: number): string {
  // Convention: HTTP statuses are 100–599; below that we treat as exit code.
  return status >= 100 && status < 600 ? `HTTP ${status}` : `exit ${status}`;
}

/** Empty-list short-circuit verdict — when all actions were filtered out by
 *  trigger, every connector returns the same shape. */
export function emptyEligibleVerdict(label: string, totalConfigured: number, skipped: number): TaskVerdict {
  return {
    ok: true,
    summary: `${label}: no actions match (${totalConfigured} configured, ${skipped} skipped by trigger)`,
    issues: [],
    details: "",
  };
}
