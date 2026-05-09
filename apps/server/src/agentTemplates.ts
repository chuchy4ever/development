/**
 * File-backed CRUD for global Skill (=agent) templates.
 *
 * Two layers of source:
 *  1. Built-ins from defaultAgents.ts — the seed library that ships with ceo.
 *  2. User overrides in `~/.ceo/agent-templates/<key>.json` — when the user
 *     edits a template in admin, we write a file with the same key that
 *     shadows the built-in. To "reset", delete the override file.
 *
 * This module is read by store.ts on every agent load to overlay the latest
 * template fields onto project agents that have a `template_key` — that's
 * how a single edit in admin propagates to every project sharing the
 * template.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { AGENT_TEMPLATES } from "./defaultAgents.js";
import type { AgentTemplate } from "@ceo/shared";

const TEMPLATES_DIR = path.join(DATA_DIR, "agent-templates");

function ensureDir(): void {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

function userPath(key: string): string {
  return path.join(TEMPLATES_DIR, `${key}.json`);
}

function readUserTemplate(key: string): AgentTemplate | null {
  const p = userPath(key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as AgentTemplate;
  } catch {
    return null;
  }
}

export function listAgentTemplates(): AgentTemplate[] {
  ensureDir();
  // Built-ins first, then overlay user files (same key replaces). User-only
  // templates (no built-in counterpart) are appended.
  const map = new Map<string, AgentTemplate>(AGENT_TEMPLATES.map((t) => [t.key, t]));
  try {
    for (const f of fs.readdirSync(TEMPLATES_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8")) as AgentTemplate;
        if (t && typeof t.key === "string") map.set(t.key, t);
      } catch { /* skip malformed file */ }
    }
  } catch { /* dir might not exist on first read */ }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgentTemplate(key: string): AgentTemplate | null {
  const user = readUserTemplate(key);
  if (user) return user;
  return AGENT_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** Save (or overwrite) a template. Built-ins can be customized — the user
 *  file with the same key will shadow it on every read. To revert, call
 *  resetUserTemplate(key). */
export function saveAgentTemplate(t: AgentTemplate): AgentTemplate {
  ensureDir();
  if (!t.key || !/^[a-z0-9_-]+$/i.test(t.key)) {
    throw new Error(`invalid template key "${t.key}" — alphanumeric + - and _ only`);
  }
  fs.writeFileSync(userPath(t.key), JSON.stringify(t, null, 2), "utf8");
  return t;
}

/** Remove a user override. If the key still exists as a built-in, reads will
 *  fall back to it. Returns true if a file was deleted, false otherwise. */
export function resetUserTemplate(key: string): boolean {
  const p = userPath(key);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/** True iff the template exists as a user override (the user has customized
 *  or added a new template). UI uses this to show a "reset to built-in" or
 *  "user-defined" indicator. */
export function isUserOverride(key: string): boolean {
  return fs.existsSync(userPath(key));
}

/** True iff the key matches a built-in template (whether or not a user
 *  override exists). */
export function isBuiltin(key: string): boolean {
  return AGENT_TEMPLATES.some((t) => t.key === key);
}
