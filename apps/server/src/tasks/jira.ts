/**
 * Jira (Atlassian Cloud) connector — fires a list of actions against the
 * project's Jira instance after a run terminates. Each action declares its
 * own trigger (always / on success / on failure), so a single phase can
 * cover the full lifecycle (e.g. comment always + transition to Done on
 * success + transition to Blocked on failure).
 *
 * Auth via project secrets: jira_base_url + jira_email + jira_api_token.
 *
 * Config shape:
 *   {
 *     default_issue_key?: string,           // applied to actions that omit issue_key
 *     actions: [
 *       { on: "always"|"success"|"failure", action: "comment", issue_key?, body },
 *       { on: ..., action: "transition", issue_key?, transition_name | transition_id },
 *       …
 *     ]
 *   }
 *
 * Backward compat: old single-action configs (with top-level action/issue_key/
 * body/transition_name) are silently wrapped into a one-element actions[].
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

interface JiraAction {
  on: Trigger;
  action: "comment" | "transition";
  issue_key?: string;
  body?: string;
  transition_name?: string;
  transition_id?: string;
}

interface JiraConfig {
  default_issue_key?: string;
  actions: JiraAction[];
}

interface JiraCreds { baseUrl: string; email: string; apiToken: string }

function basicAuth(c: JiraCreds): string {
  return "Basic " + Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
}

async function jiraFetch(
  c: JiraCreds, url: string, init: RequestInit, signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: basicAuth(c),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal,
  });
  return { status: res.status, body: await res.text() };
}

/** Atlassian Document Format — minimal "plain paragraph" wrapper. */
function adfFromText(text: string): unknown {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

async function resolveTransitionId(
  creds: JiraCreds, action: JiraAction, issueKey: string, signal: AbortSignal,
): Promise<{ id: string } | { error: string }> {
  if (action.transition_id) return { id: action.transition_id };
  if (!action.transition_name) return { error: 'requires "transition_name" or "transition_id"' };
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
  const res = await jiraFetch(creds, url, { method: "GET" }, signal);
  if (res.status < 200 || res.status >= 300) {
    return { error: `transitions list HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  }
  let parsed: { transitions?: { id: string; name: string }[] };
  try { parsed = JSON.parse(res.body); } catch { return { error: "transitions list returned non-JSON" }; }
  const target = action.transition_name.toLowerCase();
  const match = (parsed.transitions ?? []).find((t) => t.name.toLowerCase() === target);
  if (!match) {
    const names = (parsed.transitions ?? []).map((t) => t.name).join(", ");
    return { error: `no transition named "${action.transition_name}". Available: ${names}` };
  }
  return { id: match.id };
}

/** Normalize legacy { action, issue_key, body, ... } single-action configs
 *  into the new { actions: [...] } shape so the executor only deals with one
 *  schema. */
function normalizeConfig(raw: Record<string, unknown>): JiraConfig {
  if (Array.isArray(raw.actions)) {
    return {
      default_issue_key: typeof raw.default_issue_key === "string" ? raw.default_issue_key : undefined,
      actions: raw.actions as JiraAction[],
    };
  }
  // Legacy single-action: lift into actions[].
  if (typeof raw.action === "string") {
    return {
      default_issue_key: typeof raw.issue_key === "string" ? (raw.issue_key as string) : undefined,
      actions: [{
        on: "always",
        action: raw.action as "comment" | "transition",
        issue_key: typeof raw.issue_key === "string" ? (raw.issue_key as string) : undefined,
        body: typeof raw.body === "string" ? (raw.body as string) : undefined,
        transition_name: typeof raw.transition_name === "string" ? (raw.transition_name as string) : undefined,
        transition_id: typeof raw.transition_id === "string" ? (raw.transition_id as string) : undefined,
      }],
    };
  }
  return { actions: [] };
}

export const jiraExecutor: TaskExecutor = {
  type: "jira",

  validate(config) {
    const c = normalizeConfig(config);
    if (!Array.isArray(c.actions) || c.actions.length === 0) {
      return 'jira: needs at least one action (use the "+ Add action" button)';
    }
    for (let i = 0; i < c.actions.length; i++) {
      const a = c.actions[i]!;
      if (a.on !== "always" && a.on !== "success" && a.on !== "failure") {
        return `jira action #${i + 1}: "on" must be "always" | "success" | "failure"`;
      }
      if (a.action !== "comment" && a.action !== "transition") {
        return `jira action #${i + 1}: "action" must be "comment" | "transition"`;
      }
      const issueKey = a.issue_key ?? c.default_issue_key;
      if (!issueKey) return `jira action #${i + 1}: needs issue_key (or set default_issue_key)`;
      if (a.action === "comment" && !a.body) {
        return `jira action #${i + 1}: comment requires "body"`;
      }
      if (a.action === "transition" && !a.transition_id && !a.transition_name) {
        return `jira action #${i + 1}: transition requires "transition_name" or "transition_id"`;
      }
    }
    return null;
  },

  async run(config, ctx): Promise<TaskVerdict> {
    const c = normalizeConfig(config);
    const creds: JiraCreds = {
      baseUrl: getProjectSecret(ctx.project.id, "jira_base_url").replace(/\/$/, ""),
      email: getProjectSecret(ctx.project.id, "jira_email"),
      apiToken: getProjectSecret(ctx.project.id, "jira_api_token"),
    };
    if (!creds.baseUrl || !creds.email || !creds.apiToken) {
      return {
        ok: false,
        summary: "jira: project secrets not all set (need jira_base_url, jira_email, jira_api_token)",
        issues: ["missing Jira credentials"],
        details: "",
      };
    }

    const vars = buildVars(ctx);
    // Filter to actions whose trigger matches the run outcome. Skipped actions
    // are recorded in the summary so users see them in the run log.
    const eligible = c.actions.filter((a) => shouldFire(a.on, ctx.lastWasFailure));
    const skipped = c.actions.length - eligible.length;
    if (eligible.length === 0) return emptyEligibleVerdict("jira", c.actions.length, skipped);

    const controller = new AbortController();
    let cancelled = false;
    ctx.registerCancel(() => { cancelled = true; controller.abort(); });

    const results: ActionResult[] = [];

    for (const a of eligible) {
      if (cancelled) break;
      const issueKey = a.issue_key ?? c.default_issue_key!;
      let url: string;
      let init: RequestInit;
      let preview: string;

      if (a.action === "comment") {
        url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
        const body = render(a.body!, vars);
        init = { method: "POST", body: JSON.stringify({ body: adfFromText(body) }) };
        preview = `comment on ${issueKey}`;
      } else {
        const t = await resolveTransitionId(creds, a, issueKey, controller.signal);
        if ("error" in t) {
          results.push({ ok: false, preview: `transition ${issueKey}`, status: 0, body: t.error });
          continue;
        }
        url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
        init = { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) };
        preview = `transition ${issueKey} → ${a.transition_name ?? t.id}`;
      }

      ctx.emit("command_start", { phase_id: ctx.phase.id, command: `jira → ${preview}` });
      try {
        const r = await jiraFetch(creds, url, init, controller.signal);
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

    return aggregateResults({ label: "jira", results, totalConfigured: c.actions.length });
  },

  async read({ project, params }) {
    const key = String(params.key ?? "").trim();
    if (!key) return { ok: false, content: "", error: 'jira read requires "key" (e.g. JIRA-123)' };
    const creds: JiraCreds = {
      baseUrl: getProjectSecret(project.id, "jira_base_url").replace(/\/$/, ""),
      email: getProjectSecret(project.id, "jira_email"),
      apiToken: getProjectSecret(project.id, "jira_api_token"),
    };
    if (!creds.baseUrl || !creds.email || !creds.apiToken) {
      return { ok: false, content: "", error: "jira: missing project secrets (jira_base_url / jira_email / jira_api_token)" };
    }
    const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,assignee,priority,labels,issuetype`;
    const ac = new AbortController();
    try {
      const r = await jiraFetch(creds, url, { method: "GET" }, ac.signal);
      if (r.status < 200 || r.status >= 300) {
        return { ok: false, content: "", error: `jira HTTP ${r.status}: ${r.body.slice(0, 300)}` };
      }
      const issue = JSON.parse(r.body) as {
        key: string;
        fields: {
          summary?: string;
          description?: unknown;
          status?: { name?: string };
          assignee?: { displayName?: string };
          priority?: { name?: string };
          labels?: string[];
          issuetype?: { name?: string };
        };
      };
      const f = issue.fields ?? {};
      const desc = adfToText(f.description);
      const lines: string[] = [
        `# Jira ${issue.key}: ${f.summary ?? "(no summary)"}`,
        ``,
        `- type: ${f.issuetype?.name ?? "?"}`,
        `- status: ${f.status?.name ?? "?"}`,
        `- assignee: ${f.assignee?.displayName ?? "(unassigned)"}`,
        `- priority: ${f.priority?.name ?? "?"}`,
      ];
      if (f.labels && f.labels.length > 0) lines.push(`- labels: ${f.labels.join(", ")}`);
      if (desc.trim()) {
        lines.push(``, `## Description`, desc.slice(0, 4000));
        if (desc.length > 4000) lines.push(`\n[... truncated, original ${desc.length} chars]`);
      }
      return { ok: true, content: lines.join("\n") };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: "", error: `jira fetch failed: ${msg}` };
    }
  },
};

/** Best-effort flattening of Atlassian Document Format into plain text. Walks
 *  nested content arrays, collecting leaf `text` nodes with paragraph breaks. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const obj = n as { type?: string; text?: string; content?: unknown[] };
    if (typeof obj.text === "string") out.push(obj.text);
    if (Array.isArray(obj.content)) {
      for (const c of obj.content) walk(c);
      if (obj.type === "paragraph" || obj.type === "heading") out.push("\n");
    }
  };
  walk(node);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}
