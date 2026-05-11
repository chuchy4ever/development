/**
 * Per-project secrets / config for connectors. Plaintext on disk (user's
 * machine); never returned to the UI as plaintext — the masked-list endpoint
 * shows the last 4 chars only.
 *
 * Resolution order at task fire time: project secret → env fallback → empty.
 * Env fallback exists so deployments that already use env vars keep working;
 * project-level wins so per-project orgs / Atlassian instances / SSH keys
 * Just Work without polluting the global env.
 */

import { db, nowIso } from "./db.js";
import { getGlobalSecret } from "./globalSecrets.js";

/** Known keys + their UI metadata. Adding a connector that needs a new field
 *  means registering it here so the UI auto-renders the input. */
export interface SecretSpec {
  key: string;
  label: string;
  /** When true, masked on read (tokens / passwords). When false (e.g. base URL,
   *  default repo), the full value is returned to the UI. */
  secret: boolean;
  /** Optional env var name used as fallback when the project doesn't set this. */
  envFallback?: string;
  /** UI hint shown under the input. */
  hint?: string;
}

export const SECRET_SPECS: SecretSpec[] = [
  // GitHub
  { key: "github_token", label: "GitHub token", secret: true, envFallback: "GITHUB_TOKEN", hint: "Personal access token with repo scope." },
  // Jira
  { key: "jira_base_url", label: "Jira base URL", secret: false, envFallback: "JIRA_BASE_URL", hint: "e.g. https://your-org.atlassian.net (no trailing slash)." },
  { key: "jira_email", label: "Jira account email", secret: false, envFallback: "JIRA_EMAIL", hint: "Atlassian Cloud uses email + API token for basic auth." },
  { key: "jira_api_token", label: "Jira API token", secret: true, envFallback: "JIRA_API_TOKEN", hint: "Generate at id.atlassian.com → Security → API tokens." },
  // SSH
  { key: "ssh_key_path", label: "SSH private key path", secret: false, envFallback: "SSH_KEY_PATH", hint: "Absolute path on this server. Key-based auth required (BatchMode)." },
  {
    key: "ssh_default_target",
    label: "Default SSH target",
    secret: false,
    envFallback: "SSH_DEFAULT_TARGET",
    hint: 'Default target. Format: user@host or user@host:port (e.g. "deploy@1.2.3.4:25"). Phase host field overrides this when set.',
  },
];

/** Lookup a single secret. Resolution order:
 *    1. project_secrets row for this project + key
 *    2. global_secrets row (admin-level)
 *    3. env-var fallback declared on the SECRET_SPEC
 *    4. empty string
 *  Steps 2–3 are delegated to getGlobalSecret to keep the chain in one place. */
export function getProjectSecret(projectId: string, key: string): string {
  const row = db
    .prepare("SELECT value FROM project_secrets WHERE project_id = ? AND key = ?")
    .get(projectId, key) as { value: string } | undefined;
  if (row?.value) return row.value;
  // Circular dependency with globalSecrets.ts is fine here — Node ESM resolves
  // bindings lazily for function exports, and getGlobalSecret is only called
  // at runtime (never during module init).
  return getGlobalSecret(key);
}

export function setProjectSecret(projectId: string, key: string, value: string): void {
  if (!SECRET_SPECS.some((s) => s.key === key)) {
    throw new Error(`unknown secret key "${key}"`);
  }
  if (!value) {
    db.prepare("DELETE FROM project_secrets WHERE project_id = ? AND key = ?").run(projectId, key);
    return;
  }
  db.prepare(
    `INSERT INTO project_secrets (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(projectId, key, value, nowIso());
}

export function deleteProjectSecret(projectId: string, key: string): void {
  db.prepare("DELETE FROM project_secrets WHERE project_id = ? AND key = ?").run(projectId, key);
}

/** UI-safe listing: secret-typed values masked to last-4 chars; non-secret
 *  values returned in full. Always returns one entry per known spec, with
 *  source = "project" | "env" | "unset" so the UI can show provenance. */
export interface MaskedSecret {
  key: string;
  label: string;
  secret: boolean;
  hint?: string;
  /** Where the live value comes from. */
  source: "project" | "env" | "unset";
  /** Masked-or-plaintext display value. Empty when source = "unset". */
  display: string;
  /** Whether the project has a row for this key (regardless of env). */
  has_project_value: boolean;
  updated_at: string | null;
}

export function mask(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return "•".repeat(Math.min(value.length - 4, 12)) + value.slice(-4);
}

/** Render a SECRET_SPECS-shaped masked list from a row map. Shared by project
 *  and global secret listings — only the SQL source differs.
 *  `byKey`: stored rows keyed by SECRET_SPECS.key (the "set in this scope" rows).
 *  Output preserves SECRET_SPECS order. */
export function buildMaskedList(
  byKey: Map<string, { value: string; updated_at: string }>,
): MaskedSecret[] {
  return SECRET_SPECS.map((spec) => {
    const row = byKey.get(spec.key);
    let source: MaskedSecret["source"] = "unset";
    let live = "";
    if (row?.value) {
      source = "project";
      live = row.value;
    } else if (spec.envFallback && process.env[spec.envFallback]) {
      source = "env";
      live = process.env[spec.envFallback] ?? "";
    }
    return {
      key: spec.key,
      label: spec.label,
      secret: spec.secret,
      hint: spec.hint,
      source,
      display: live ? (spec.secret ? mask(live) : live) : "",
      has_project_value: !!row,
      updated_at: row?.updated_at ?? null,
    };
  });
}

export function listProjectSecretsMasked(projectId: string): MaskedSecret[] {
  const rows = db
    .prepare("SELECT key, value, updated_at FROM project_secrets WHERE project_id = ?")
    .all(projectId) as { key: string; value: string; updated_at: string }[];
  const byKey = new Map(rows.map((r) => [r.key, { value: r.value, updated_at: r.updated_at }]));
  return buildMaskedList(byKey);
}

