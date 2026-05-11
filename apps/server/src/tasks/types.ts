import type { ProjectWithRepos, Ticket, WorkflowPhase } from "@ceo/shared";

/** Verdict shape produced by every task executor. Matches what the engine
 *  consumes from agent phases (ok / summary / issues), so downstream routing
 *  is identical for agent and task phases. */
export interface TaskVerdict {
  ok: boolean;
  summary: string;
  issues: string[];
  /** Last few KB of relevant output (stdout for shell, response body for HTTP, …). */
  details?: string;
  /** Optional extra fields a particular task wants to surface. */
  [k: string]: unknown;
}

export interface TaskContext {
  runId: string;
  /** Run worktree root (parent dir of all repo worktrees). */
  runDir: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  phase: WorkflowPhase;
  /** Verdict from the immediately preceding phase, if any. Useful for
   *  notification tasks that want to summarise success/failure. */
  lastVerdict: unknown | null;
  /** True when the task is on a retry path (last verdict was not ok). */
  lastWasFailure: boolean;
  emit: (event: string, payload: Record<string, unknown>) => void;
  /** Register a handle so the engine can kill the task on user cancel. */
  registerCancel: (cancel: () => void) => void;
  unregisterCancel: () => void;
}

/** Read-side request for a connector. Used by Director when a ticket needs
 *  external context (e.g. the body of JIRA-123 or PR #42). Connectors that
 *  don't support reads simply omit `read()`. */
export interface TaskReadParams {
  project: ProjectWithRepos;
  /** Connector-specific params. Each executor documents its shape:
   *   - jira:   { key: string }
   *   - github: { kind: "pr" | "issue", repo: string, number: number }
   *   - ssh:    { host?: string, path: string } */
  params: Record<string, unknown>;
}

export interface TaskReadResult {
  ok: boolean;
  /** Markdown-formatted summary suitable for inclusion in a Director / sub-agent prompt. */
  content: string;
  error?: string;
}

export interface TaskExecutor {
  type: string;
  /** Validate config at PUT time. Return null if ok, or an error message. */
  validate(config: Record<string, unknown>): string | null;
  /** Execute the task. Should always resolve (never throw); errors → ok=false verdict. */
  run(config: Record<string, unknown>, ctx: TaskContext): Promise<TaskVerdict>;
  /** Optional: read external data from the connector's source. Used by Director
   *  to pull ticket / PR / file context during a run. Should always resolve
   *  (never throw); errors → ok=false. */
  read?(params: TaskReadParams): Promise<TaskReadResult>;
}
