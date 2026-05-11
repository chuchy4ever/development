import { spawn } from "node:child_process";
import path from "node:path";
import type { TaskContext, TaskExecutor, TaskVerdict } from "./types.js";

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 1800;
// 8 KB tail captures more PHPStan / pytest / npm error context than 4 KB.
// CI verdicts often have 1-2 KB of header (test setup, list of files scanned)
// followed by the actual failures at the bottom; 4 KB was clipping real
// errors out of the message Director sees.
const OUTPUT_TAIL_BYTES = 8192;

interface ShellConfig {
  command: string;
  working_dir?: string | null;
  timeout_sec?: number;
}

function appendTail(buf: string, chunk: string, maxBytes: number): string {
  const combined = buf + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  let out = combined;
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(Math.max(1, Math.floor(out.length / 8)));
  }
  return out;
}

function resolveCwd(runDir: string, workingDir: string | null | undefined): string {
  if (!workingDir || workingDir.trim() === "") return runDir;
  const resolved = path.resolve(runDir, workingDir);
  const rel = path.relative(runDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`working_dir "${workingDir}" escapes run root`);
  }
  return resolved;
}

export const shellExecutor: TaskExecutor = {
  type: "shell",

  validate(config) {
    const c = config as Partial<ShellConfig>;
    if (!c.command || typeof c.command !== "string" || c.command.trim() === "") {
      return "shell: 'command' is required and must be a non-empty string";
    }
    if (c.timeout_sec !== undefined && (typeof c.timeout_sec !== "number" || c.timeout_sec <= 0)) {
      return "shell: 'timeout_sec' must be a positive number";
    }
    if (c.working_dir !== undefined && c.working_dir !== null && typeof c.working_dir !== "string") {
      return "shell: 'working_dir' must be a string or null";
    }
    return null;
  },

  async run(config, ctx) {
    const c = config as unknown as ShellConfig;
    const command = c.command.trim();
    const timeoutSec = Math.min(Math.max(c.timeout_sec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);

    let cwd: string;
    try {
      cwd = resolveCwd(ctx.runDir, c.working_dir ?? null);
    } catch (e: any) {
      return {
        ok: false,
        summary: `shell cwd error: ${e.message ?? e}`,
        issues: [String(e.message ?? e)],
        details: "",
      };
    }

    const startedAt = Date.now();
    ctx.emit("command_start", { phase_id: ctx.phase.id, command, cwd, timeout_sec: timeoutSec });

    const proc = spawn("bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    let cancelled = false;
    let timedOut = false;
    let tail = "";

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutSec * 1000);

    ctx.registerCancel(() => {
      cancelled = true;
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    });

    proc.stdout!.on("data", (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      tail = appendTail(tail, s, OUTPUT_TAIL_BYTES);
      ctx.emit("command_output", { phase_id: ctx.phase.id, stream: "stdout", chunk: s });
    });
    proc.stderr!.on("data", (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      tail = appendTail(tail, s, OUTPUT_TAIL_BYTES);
      ctx.emit("command_output", { phase_id: ctx.phase.id, stream: "stderr", chunk: s });
    });

    const exitCode: number = await new Promise((resolve) => {
      proc.on("error", (err) => {
        tail = appendTail(tail, `\n[spawn error] ${err.message}\n`, OUTPUT_TAIL_BYTES);
        resolve(-1);
      });
      proc.on("close", (code) => resolve(code ?? -1));
    });

    clearTimeout(killTimer);
    ctx.unregisterCancel();

    const durationMs = Date.now() - startedAt;
    const ok = exitCode === 0 && !timedOut && !cancelled;

    const issues: string[] = [];
    if (cancelled) issues.push("cancelled by user");
    if (timedOut) issues.push(`timed out after ${timeoutSec}s`);
    if (!ok && exitCode !== 0) issues.push(`exit ${exitCode}`);
    const lastLines = tail.split("\n").filter((l) => l.trim() !== "").slice(-5);
    for (const line of lastLines) issues.push(line.length > 200 ? line.slice(0, 200) + "…" : line);

    const summary = ok
      ? `\`${command}\` → exit 0 in ${durationMs}ms`
      : timedOut
      ? `\`${command}\` → TIMEOUT after ${timeoutSec}s`
      : cancelled
      ? `\`${command}\` → cancelled`
      : `\`${command}\` → exit ${exitCode} in ${durationMs}ms`;

    ctx.emit("command_end", {
      phase_id: ctx.phase.id,
      exit_code: exitCode,
      duration_ms: durationMs,
      timed_out: timedOut,
      cancelled,
    });

    const verdict: TaskVerdict = {
      ok,
      summary,
      issues,
      details: tail,
      exit_code: exitCode,
      duration_ms: durationMs,
    };
    return verdict;
  },
};

// Re-export TaskContext for callers that want to construct one for tests.
export type { TaskContext };
