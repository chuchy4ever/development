import type { TaskContext, TaskExecutor, TaskReadParams, TaskReadResult, TaskVerdict } from "./types.js";
import type { ProjectWithRepos } from "@ceo/shared";
import { shellExecutor } from "./shell.js";
import { telegramExecutor } from "./telegram.js";
import { githubExecutor } from "./github.js";
import { jiraExecutor } from "./jira.js";
import { sshExecutor } from "./ssh.js";
import { gitPushExecutor } from "./git.js";

const REGISTRY = new Map<string, TaskExecutor>();
function register(e: TaskExecutor) {
  REGISTRY.set(e.type, e);
}

register(shellExecutor);
register(telegramExecutor);
register(githubExecutor);
register(jiraExecutor);
register(sshExecutor);
register(gitPushExecutor);

/** Connector tasks = side-effect integrations toward external systems. They
 *  aren't gates (no retry routing, never block mark_done). UI groups them in
 *  a separate panel; the engine treats them like any other task but they're
 *  the natural fit for workflow.on_success / on_failure hooks. */
export const CONNECTOR_TASK_TYPES: ReadonlySet<string> = new Set(["telegram", "github", "jira", "ssh", "git_push"]);

export function isConnectorTask(type: string): boolean {
  return CONNECTOR_TASK_TYPES.has(type);
}

export function getTaskExecutor(type: string): TaskExecutor | undefined {
  return REGISTRY.get(type);
}

export function listTaskTypes(): string[] {
  return [...REGISTRY.keys()];
}

/** Validate a task config against its executor. Returns null if ok, or an error message. */
export function validateTaskConfig(type: string, config: Record<string, unknown>): string | null {
  const exec = REGISTRY.get(type);
  if (!exec) return `unknown task type "${type}"`;
  return exec.validate(config);
}

/** Execute a task. Always resolves; failures are returned as ok=false verdicts. */
export async function runTask(
  type: string,
  config: Record<string, unknown>,
  ctx: TaskContext,
): Promise<TaskVerdict> {
  const exec = REGISTRY.get(type);
  if (!exec) {
    return {
      ok: false,
      summary: `unknown task type "${type}"`,
      issues: [`unknown task type "${type}"`],
      details: "",
    };
  }
  try {
    return await exec.run(config, ctx);
  } catch (e: any) {
    return {
      ok: false,
      summary: `task "${type}" threw: ${e?.message ?? String(e)}`,
      issues: [String(e?.message ?? e)],
      details: e?.stack ?? "",
    };
  }
}

/** Read external context from a connector. Returns ok=false with an error
 *  message if the connector doesn't support reads or the call fails. Used by
 *  Director's `fetch_context` action. */
export async function readTask(
  type: string,
  project: ProjectWithRepos,
  params: Record<string, unknown>,
): Promise<TaskReadResult> {
  const exec = REGISTRY.get(type);
  if (!exec) return { ok: false, content: "", error: `unknown connector "${type}"` };
  if (!exec.read) return { ok: false, content: "", error: `connector "${type}" does not support read` };
  try {
    return await exec.read({ project, params });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, content: "", error: `${type} read threw: ${msg}` };
  }
}

/** Connectors with a working `read()` implementation. Director uses this to
 *  decide which fetch_context targets to advertise in its prompt. */
export function listReadableConnectors(): string[] {
  return [...REGISTRY.entries()].filter(([, e]) => typeof e.read === "function").map(([k]) => k);
}

export type { TaskContext, TaskExecutor, TaskReadParams, TaskReadResult, TaskVerdict };
