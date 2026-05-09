import type { TaskContext, TaskExecutor, TaskVerdict } from "./types.js";
import { shellExecutor } from "./shell.js";
import { telegramExecutor } from "./telegram.js";

const REGISTRY = new Map<string, TaskExecutor>();
function register(e: TaskExecutor) {
  REGISTRY.set(e.type, e);
}

register(shellExecutor);
register(telegramExecutor);

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

export type { TaskContext, TaskExecutor, TaskVerdict };
