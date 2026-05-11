/**
 * Centralized cost-tracking helper. Every claude CLI invocation that doesn't
 * already flow through the Director's per-run aggregator should call
 * `recordCost` so the spend is visible in:
 *   - The daily cost cap (todaysCostForProject UNIONs cost_log)
 *   - The admin dashboard (future: per-source cost breakdown)
 *
 * Pass run_id when the call happens during a Director run; this also bumps
 * `runs.total_cost_usd` so the run-level total stays accurate. Without run_id
 * the cost lives only in cost_log.
 *
 * Cost is parsed out of the `result` stream-json event emitted by claude CLI.
 * Use `extractCostFromStdout` for one-shot callers, or capture from `onLine`
 * streaming callers.
 */

import { db, nowIso } from "./db.js";

export interface RecordCostInput {
  /** Free-form source tag. Convention: lowercase + underscore. */
  source: string;
  cost_usd: number;
  /** Set when the cost belongs to a project (daily cap applies). */
  project_id?: string | null;
  /** Set when the cost is part of an active Director run. Also bumps runs.total_cost_usd. */
  run_id?: string | null;
}

export function recordCost(input: RecordCostInput): void {
  if (!Number.isFinite(input.cost_usd) || input.cost_usd <= 0) return;
  db.prepare(
    `INSERT INTO cost_log (project_id, run_id, source, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.project_id ?? null, input.run_id ?? null, input.source, input.cost_usd, nowIso());
  if (input.run_id) {
    db.prepare(
      `UPDATE runs SET total_cost_usd = COALESCE(total_cost_usd, 0) + ? WHERE id = ?`,
    ).run(input.cost_usd, input.run_id);
  }
}

/** Walk a stream-json transcript and pull out the final `result.total_cost_usd`.
 *  Returns 0 if not found (e.g. CLI errored before emitting result). */
export function extractCostFromStdout(stdout: string): number {
  if (!stdout) return 0;
  let cost = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "result" && typeof ev.total_cost_usd === "number") {
        cost = ev.total_cost_usd;
      }
    } catch {
      /* not JSON */
    }
  }
  return cost;
}
