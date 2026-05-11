/**
 * Connector connection-test logic shared between project secrets
 * (/api/projects/:id/secrets/:group/test) and global secrets
 * (/api/admin/secrets/:group/test).
 *
 * Each test takes a `get(key)` closure that resolves the secret in the
 * caller's scope (project_secrets row vs. global_secrets row), so this
 * module stays oblivious to where credentials live.
 */

import fs from "node:fs";
import { db, nowIso } from "./db.js";

export type SecretGroup = "github" | "jira" | "ssh";

export interface TestResult {
  ok: boolean;
  message: string;
}

/** Run the connection test for a connector group using the provided secret
 *  resolver. Returns ok=false with a human-readable message on auth or
 *  configuration failure — never throws.
 *
 *  When `scope` is provided ('global' or a project_id), the result is
 *  persisted to `connector_health` so the UI can show last-tested + status
 *  badges without re-hitting the API on every page render. */
export async function testConnector(
  group: string,
  get: (key: string) => string,
  scope?: string,
): Promise<TestResult> {
  let result: TestResult;
  if (group === "github") result = await testGithub(get);
  else if (group === "jira") result = await testJira(get);
  else if (group === "ssh") result = testSsh(get);
  else result = { ok: false, message: `unknown group "${group}"` };

  if (scope) {
    db.prepare(
      `INSERT INTO connector_health (scope, group_name, last_tested_at, ok, error)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, group_name) DO UPDATE SET
         last_tested_at = excluded.last_tested_at,
         ok = excluded.ok,
         error = excluded.error`,
    ).run(scope, group, nowIso(), result.ok ? 1 : 0, result.ok ? null : result.message);
  }
  return result;
}

export interface ConnectorHealthRow {
  scope: string;
  group_name: string;
  last_tested_at: string;
  ok: boolean;
  error: string | null;
}

/** Read all stored health rows for a scope ('global' or project_id). */
export function listConnectorHealth(scope: string): ConnectorHealthRow[] {
  const rows = db
    .prepare(
      `SELECT scope, group_name, last_tested_at, ok, error
         FROM connector_health WHERE scope = ?`,
    )
    .all(scope) as Array<{ scope: string; group_name: string; last_tested_at: string; ok: number; error: string | null }>;
  return rows.map((r) => ({ ...r, ok: r.ok === 1 }));
}

async function testGithub(get: (key: string) => string): Promise<TestResult> {
  const token = get("github_token");
  if (!token) return { ok: false, message: "github_token is not set" };
  const r = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) return { ok: false, message: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const u = (await r.json()) as { login?: string; name?: string };
  return { ok: true, message: `Authenticated as ${u.login}${u.name ? ` (${u.name})` : ""}` };
}

async function testJira(get: (key: string) => string): Promise<TestResult> {
  const baseUrl = get("jira_base_url").replace(/\/$/, "");
  const email = get("jira_email");
  const token = get("jira_api_token");
  if (!baseUrl || !email || !token) return { ok: false, message: "set base_url + email + api_token first" };
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  const r = await fetch(`${baseUrl}/rest/api/3/myself`, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!r.ok) return { ok: false, message: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const u = (await r.json()) as { displayName?: string; emailAddress?: string };
  return { ok: true, message: `Authenticated as ${u.displayName} (${u.emailAddress})` };
}

function testSsh(get: (key: string) => string): TestResult {
  const keyPath = get("ssh_key_path");
  if (!keyPath) return { ok: false, message: "ssh_key_path is not set" };
  try {
    const stat = fs.statSync(keyPath);
    if (!stat.isFile()) return { ok: false, message: `${keyPath} is not a file` };
    return { ok: true, message: `Key file exists (${stat.size} B). Real connection requires a host — try a watch job's ▶ to verify.` };
  } catch (e: unknown) {
    return { ok: false, message: `${keyPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
