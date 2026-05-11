/**
 * GitHub connector — fires a list of actions against the project's GitHub
 * after a run terminates. One phase = one connection (project secrets) +
 * many actions, each with its own trigger.
 *
 * Auth via project secret `github_token` (PAT with repo scope).
 *
 * Config shape:
 *   {
 *     default_repo?: "owner/name",     // applied to actions that omit repo
 *     actions: [
 *       { on: "always"|"success"|"failure", action: "issue_comment", repo?, issue_number, body },
 *       { on: ..., action: "set_labels", repo?, issue_number, labels: string[] },
 *       { on: ..., action: "close_issue", repo?, issue_number },
 *     ]
 *   }
 *
 * Backward compat: legacy single-action shape (top-level action/repo/issue_number/...) is
 * auto-wrapped into actions[].
 */

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

interface GhAction {
  on: Trigger;
  action: "issue_comment" | "set_labels" | "close_issue";
  repo?: string;
  issue_number: number;
  body?: string;
  labels?: string[];
}

interface GitHubConfig {
  default_repo?: string;
  actions: GhAction[];
}

function resolveRepo(repoStr: string | undefined, fallback: string): { owner: string; name: string } | null {
  const raw = (repoStr ?? fallback).trim();
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}

async function ghFetch(
  token: string, url: string, init: RequestInit, signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal,
  });
  return { status: res.status, body: await res.text() };
}

function normalizeConfig(raw: Record<string, unknown>): GitHubConfig {
  if (Array.isArray(raw.actions)) {
    return {
      default_repo: typeof raw.default_repo === "string" ? raw.default_repo : (typeof raw.repo === "string" ? raw.repo : undefined),
      actions: raw.actions as GhAction[],
    };
  }
  // Legacy single-action.
  if (typeof raw.action === "string") {
    return {
      default_repo: typeof raw.repo === "string" ? (raw.repo as string) : undefined,
      actions: [{
        on: "always",
        action: raw.action as GhAction["action"],
        repo: typeof raw.repo === "string" ? (raw.repo as string) : undefined,
        issue_number: Number(raw.issue_number ?? 0),
        body: typeof raw.body === "string" ? (raw.body as string) : undefined,
        labels: Array.isArray(raw.labels) ? (raw.labels as string[]) : undefined,
      }],
    };
  }
  return { actions: [] };
}

export const githubExecutor: TaskExecutor = {
  type: "github",

  validate(config) {
    const c = normalizeConfig(config);
    if (c.actions.length === 0) return 'github: needs at least one action (use "+ Add action")';
    for (let i = 0; i < c.actions.length; i++) {
      const a = c.actions[i]!;
      if (a.on !== "always" && a.on !== "success" && a.on !== "failure") {
        return `github action #${i + 1}: "on" must be "always" | "success" | "failure"`;
      }
      if (!["issue_comment", "set_labels", "close_issue"].includes(a.action)) {
        return `github action #${i + 1}: "action" must be "issue_comment" | "set_labels" | "close_issue"`;
      }
      if (!Number.isInteger(a.issue_number) || a.issue_number <= 0) {
        return `github action #${i + 1}: "issue_number" must be a positive integer`;
      }
      if (a.action === "issue_comment" && !a.body) {
        return `github action #${i + 1}: issue_comment requires "body"`;
      }
      if (a.action === "set_labels" && (!Array.isArray(a.labels) || a.labels.length === 0)) {
        return `github action #${i + 1}: set_labels requires non-empty "labels"`;
      }
    }
    return null;
  },

  async run(config, ctx): Promise<TaskVerdict> {
    const c = normalizeConfig(config);
    const token = getProjectSecret(ctx.project.id, "github_token");
    if (!token) {
      return { ok: false, summary: "github: token not configured (project settings → github_token)", issues: ["missing github_token"], details: "" };
    }

    const vars = buildVars(ctx);
    // Phase config's `default_repo` is the only fallback now — no project-level
    // secret, no env var. Most phases set repo per-action anyway.
    const fallbackRepo = "";
    const eligible = c.actions.filter((a) => shouldFire(a.on, ctx.lastWasFailure));
    const skipped = c.actions.length - eligible.length;
    if (eligible.length === 0) return emptyEligibleVerdict("github", c.actions.length, skipped);

    const controller = new AbortController();
    let cancelled = false;
    ctx.registerCancel(() => { cancelled = true; controller.abort(); });

    const results: ActionResult[] = [];

    for (const a of eligible) {
      if (cancelled) break;
      const repo = resolveRepo(a.repo ?? c.default_repo, fallbackRepo);
      if (!repo) {
        results.push({ ok: false, preview: `${a.action} #${a.issue_number}`, status: 0, body: "repo unresolved" });
        continue;
      }
      const base = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${a.issue_number}`;
      let url: string;
      let init: RequestInit;
      let preview: string;
      if (a.action === "issue_comment") {
        url = `${base}/comments`;
        init = { method: "POST", body: JSON.stringify({ body: render(a.body!, vars) }) };
        preview = `comment on ${repo.owner}/${repo.name}#${a.issue_number}`;
      } else if (a.action === "set_labels") {
        url = `${base}/labels`;
        init = { method: "PUT", body: JSON.stringify({ labels: a.labels }) };
        preview = `labels(${a.labels!.join(",")}) on ${repo.owner}/${repo.name}#${a.issue_number}`;
      } else {
        url = base;
        init = { method: "PATCH", body: JSON.stringify({ state: "closed" }) };
        preview = `close ${repo.owner}/${repo.name}#${a.issue_number}`;
      }
      ctx.emit("command_start", { phase_id: ctx.phase.id, command: `github → ${preview}` });
      try {
        const r = await ghFetch(token, url, init, controller.signal);
        const okOne = r.status >= 200 && r.status < 300;
        results.push({ ok: okOne, preview, status: r.status, body: r.body });
        ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: okOne ? 0 : 1, http_status: r.status });
      } catch (e: unknown) {
        const msg = cancelled ? "cancelled" : e instanceof Error ? e.message : String(e);
        results.push({ ok: false, preview, status: 0, body: msg });
        ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: -1, cancelled });
      }
    }
    ctx.unregisterCancel();

    return aggregateResults({ label: "github", results, totalConfigured: c.actions.length });
  },

  async read({ project, params }) {
    const kind = String(params.kind ?? "issue");
    if (kind !== "pr" && kind !== "issue") {
      return { ok: false, content: "", error: 'github read: "kind" must be "pr" or "issue"' };
    }
    const repoStr = String(params.repo ?? "").trim();
    const number = Number(params.number);
    if (!repoStr.includes("/") || !Number.isInteger(number) || number <= 0) {
      return { ok: false, content: "", error: 'github read needs { repo: "owner/name", number, kind }' };
    }
    const token = getProjectSecret(project.id, "github_token");
    if (!token) return { ok: false, content: "", error: "github: missing project secret github_token" };
    const repo = resolveRepo(repoStr, "");
    if (!repo) return { ok: false, content: "", error: `github read: bad repo "${repoStr}"` };
    const path = kind === "pr" ? "pulls" : "issues";
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/${path}/${number}`;
    const ac = new AbortController();
    try {
      const r = await ghFetch(token, url, { method: "GET" }, ac.signal);
      if (r.status < 200 || r.status >= 300) {
        return { ok: false, content: "", error: `github HTTP ${r.status}: ${r.body.slice(0, 300)}` };
      }
      const data = JSON.parse(r.body) as {
        title?: string;
        state?: string;
        body?: string | null;
        user?: { login?: string };
        labels?: { name?: string }[];
        head?: { ref?: string };
        base?: { ref?: string };
        merged?: boolean;
        draft?: boolean;
        html_url?: string;
      };
      const lines: string[] = [
        `# ${kind === "pr" ? "PR" : "Issue"} ${repo.owner}/${repo.name}#${number}: ${data.title ?? "(no title)"}`,
        ``,
        `- state: ${data.state ?? "?"}${kind === "pr" ? (data.merged ? " (merged)" : data.draft ? " (draft)" : "") : ""}`,
        `- author: ${data.user?.login ?? "?"}`,
      ];
      if (kind === "pr" && data.head && data.base) {
        lines.push(`- branch: ${data.head.ref} → ${data.base.ref}`);
      }
      if (data.labels && data.labels.length > 0) {
        lines.push(`- labels: ${data.labels.map((l) => l.name).filter(Boolean).join(", ")}`);
      }
      if (data.html_url) lines.push(`- url: ${data.html_url}`);
      const body = (data.body ?? "").trim();
      if (body) {
        lines.push(``, `## Body`, body.slice(0, 4000));
        if (body.length > 4000) lines.push(`\n[... truncated, original ${body.length} chars]`);
      }
      return { ok: true, content: lines.join("\n") };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: "", error: `github fetch failed: ${msg}` };
    }
  },
};
