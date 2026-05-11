/**
 * Server-wide secrets (admin level). Mirrors project_secrets but without a
 * project_id — used by global jobs (no project scope) that need connector
 * credentials. Same SECRET_SPECS registry, same masking rules.
 *
 * Resolution from a global job:
 *   getGlobalSecret(key) → DB row → env-var fallback (matches project flow)
 *
 * Resolution from a project job:
 *   getProjectSecret(projectId, key) → project DB row → global DB row → env-var
 *   (so a project leaves a key blank and inherits from admin defaults).
 */

import { db, nowIso } from "./db.js";
import { SECRET_SPECS, buildMaskedList, type MaskedSecret } from "./projectSecrets.js";

export function getGlobalSecret(key: string): string {
  const row = db
    .prepare("SELECT value FROM global_secrets WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (row?.value) return row.value;
  const spec = SECRET_SPECS.find((s) => s.key === key);
  if (spec?.envFallback) return process.env[spec.envFallback] ?? "";
  return "";
}

export function setGlobalSecret(key: string, value: string): void {
  if (!SECRET_SPECS.some((s) => s.key === key)) {
    throw new Error(`unknown secret key "${key}"`);
  }
  if (!value) {
    db.prepare("DELETE FROM global_secrets WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO global_secrets (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function deleteGlobalSecret(key: string): void {
  db.prepare("DELETE FROM global_secrets WHERE key = ?").run(key);
}

export function listGlobalSecretsMasked(): MaskedSecret[] {
  const rows = db
    .prepare("SELECT key, value, updated_at FROM global_secrets")
    .all() as { key: string; value: string; updated_at: string }[];
  const byKey = new Map(rows.map((r) => [r.key, { value: r.value, updated_at: r.updated_at }]));
  return buildMaskedList(byKey);
}
