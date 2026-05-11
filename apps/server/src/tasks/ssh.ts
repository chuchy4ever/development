/**
 * SSH connector — runs a list of remote commands after a run terminates,
 * each with its own trigger (always / on success / on failure). One phase =
 * one connection (host + key from project secrets) + many commands.
 *
 * Auth: project secrets ssh_key_path + ssh_default_user. Invokes the system
 * ssh client with BatchMode=yes (no password prompts).
 *
 * Config shape:
 *   {
 *     host: "user@example.com" | "alias",   // shared by all actions
 *     port?: number,                         // shared
 *     timeout_sec?: number,                  // shared per-command
 *     actions: [
 *       { on: "always"|"success"|"failure", command, working_dir? }
 *     ]
 *   }
 *
 * Backward compat: legacy { host, command, working_dir, ... } single-command
 * shape lifts into actions[].
 */

import { spawn } from "node:child_process";
import type { TaskExecutor, TaskVerdict } from "./types.js";
import { getProjectSecret } from "../projectSecrets.js";
import {
  type Trigger,
  shouldFire,
  buildVars,
  render,
  aggregateResults,
  emptyEligibleVerdict,
  type ActionResult,
} from "./connectorShared.js";

interface SshAction {
  on: Trigger;
  command: string;
  working_dir?: string;
}

interface SshConfig {
  /** Per-phase target override. Format: user@host or user@host:port. When
   *  empty, project secret `ssh_default_target` is used. */
  host: string;
  /** Per-phase port override. When unset, port is parsed from the host string
   *  (`:port` suffix) or omitted (ssh client's default). */
  port?: number;
  timeout_sec?: number;
  actions: SshAction[];
}

/** Split a target string into target+port. Accepts:
 *   - "host"             → { target: "host", port: undefined }
 *   - "user@host"        → { target: "user@host", port: undefined }
 *   - "user@host:25"     → { target: "user@host", port: 25 }
 *   - "host:25"          → { target: "host", port: 25 }
 *  IPv6 is not supported by this parser (would need brackets) — the user can
 *  fall back to the per-phase port field for that edge case. */
function parseTarget(raw: string): { target: string; port?: number } {
  const trimmed = raw.trim();
  if (!trimmed) return { target: "" };
  const m = trimmed.match(/^(.+?):(\d+)$/);
  if (m) {
    const port = Number(m[2]);
    if (Number.isFinite(port) && port > 0) return { target: m[1]!, port };
  }
  return { target: trimmed };
}

function shellEscape(s: string): string { return `'${s.replace(/'/g, "'\\''")}'`; }

function normalizeConfig(raw: Record<string, unknown>): SshConfig {
  if (Array.isArray(raw.actions)) {
    return {
      host: String(raw.host ?? ""),
      port: typeof raw.port === "number" ? raw.port : undefined,
      timeout_sec: typeof raw.timeout_sec === "number" ? raw.timeout_sec : undefined,
      actions: raw.actions as SshAction[],
    };
  }
  // Legacy: top-level command + working_dir → single action.
  if (typeof raw.command === "string") {
    return {
      host: String(raw.host ?? ""),
      port: typeof raw.port === "number" ? raw.port : undefined,
      timeout_sec: typeof raw.timeout_sec === "number" ? raw.timeout_sec : undefined,
      actions: [{
        on: "always",
        command: raw.command as string,
        working_dir: typeof raw.working_dir === "string" ? (raw.working_dir as string) : undefined,
      }],
    };
  }
  return { host: String(raw.host ?? ""), actions: [] };
}

async function runOne(args: {
  target: string;
  keyPath: string;
  port?: number;
  timeoutSec: number;
  remote: string;
  onSpawn: (cancel: () => void) => void;
}): Promise<{ ok: boolean; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const sshArgs: string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
  if (args.keyPath) sshArgs.push("-i", args.keyPath);
  if (args.port) sshArgs.push("-p", String(args.port));
  sshArgs.push(args.target, args.remote);
  const child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => { stdout += b.toString(); });
  child.stderr.on("data", (b) => { stderr += b.toString(); });
  args.onSpawn(() => child.kill("SIGTERM"));
  const timer = setTimeout(() => child.kill("SIGTERM"), args.timeoutSec * 1000);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return { ok: exit.code === 0, code: exit.code, signal: exit.signal, stdout, stderr };
}

export const sshExecutor: TaskExecutor = {
  type: "ssh",

  validate(config) {
    const c = normalizeConfig(config);
    if (!c.host) return 'ssh: "host" is required';
    if (c.actions.length === 0) return 'ssh: needs at least one action (use "+ Add action")';
    if (c.port !== undefined && (!Number.isInteger(c.port) || c.port <= 0)) return 'ssh: "port" must be a positive integer';
    if (c.timeout_sec !== undefined && (!Number.isFinite(c.timeout_sec) || c.timeout_sec <= 0)) return 'ssh: "timeout_sec" must be positive';
    for (let i = 0; i < c.actions.length; i++) {
      const a = c.actions[i]!;
      if (a.on !== "always" && a.on !== "success" && a.on !== "failure") {
        return `ssh action #${i + 1}: "on" must be "always" | "success" | "failure"`;
      }
      if (!a.command) return `ssh action #${i + 1}: "command" is required`;
    }
    return null;
  },

  async run(config, ctx): Promise<TaskVerdict> {
    const c = normalizeConfig(config);
    const vars = buildVars(ctx);

    const keyPath = getProjectSecret(ctx.project.id, "ssh_key_path");
    // Target resolution: phase host overrides the project default. Both can
    // include user@ prefix and :port suffix (parsed out into ssh's -p arg).
    const rawTarget = c.host.trim() || getProjectSecret(ctx.project.id, "ssh_default_target");
    const parsed = parseTarget(rawTarget);
    const target = parsed.target;
    const port = c.port ?? parsed.port;
    const timeoutSec = c.timeout_sec ?? 600;

    const eligible = c.actions.filter((a) => shouldFire(a.on, ctx.lastWasFailure));
    const skipped = c.actions.length - eligible.length;
    if (eligible.length === 0) return emptyEligibleVerdict(`ssh ${target}`, c.actions.length, skipped);

    let cancelled = false;
    let activeCancel: (() => void) | null = null;
    ctx.registerCancel(() => { cancelled = true; activeCancel?.(); });

    const results: ActionResult[] = [];

    for (const a of eligible) {
      if (cancelled) break;
      const rendered = render(a.command, vars);
      const remote = a.working_dir ? `cd ${shellEscape(a.working_dir)} && ${rendered}` : rendered;
      const preview = `${target}: ${rendered.slice(0, 80)}`;
      ctx.emit("command_start", { phase_id: ctx.phase.id, command: `ssh ${preview}` });
      try {
        const r = await runOne({
          target, keyPath, port, timeoutSec, remote,
          onSpawn: (kill) => { activeCancel = kill; },
        });
        const tail = (r.stdout + r.stderr).slice(-1500);
        // status field carries the exit code so aggregateResults renders "exit N".
        results.push({ ok: r.ok, preview, status: r.code ?? undefined, body: tail });
        ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: r.code ?? -1, cancelled });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ ok: false, preview, body: msg });
        ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: -1, cancelled });
      }
      activeCancel = null;
    }
    ctx.unregisterCancel();

    return aggregateResults({ label: `ssh ${target}`, results, totalConfigured: c.actions.length });
  },

  async read({ project, params }) {
    const path = String(params.path ?? "").trim();
    if (!path) return { ok: false, content: "", error: 'ssh read requires "path"' };
    const hostOverride = typeof params.host === "string" ? params.host.trim() : "";
    const rawTarget = hostOverride || getProjectSecret(project.id, "ssh_default_target");
    const parsed = parseTarget(rawTarget);
    const target = parsed.target;
    if (!target) return { ok: false, content: "", error: "ssh read: no host (set ssh_default_target or pass host)" };
    const keyPath = getProjectSecret(project.id, "ssh_key_path");
    // Cap to 64 KB so a `cat /var/log/...` of a huge file doesn't blow up the prompt.
    const remote = `head -c 65536 ${shellEscape(path)}`;
    try {
      const r = await runOne({
        target, keyPath, port: parsed.port, timeoutSec: 30, remote,
        onSpawn: () => {},
      });
      if (!r.ok) {
        return { ok: false, content: "", error: `ssh exit ${r.code ?? "?"}: ${r.stderr.slice(0, 300) || "(no stderr)"}` };
      }
      const lines: string[] = [
        `# ${target}:${path}`,
        ``,
        "```",
        r.stdout,
        "```",
      ];
      return { ok: true, content: lines.join("\n") };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: "", error: `ssh read failed: ${msg}` };
    }
  },
};
