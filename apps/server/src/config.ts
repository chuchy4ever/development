import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const DATA_DIR = process.env.CEO_DATA_DIR ?? path.join(os.homedir(), ".ceo");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const DB_PATH = path.join(DATA_DIR, "ceo.db");

export const CLAUDE_BIN =
  process.env.CEO_CLAUDE_BIN ??
  // Default to PATH lookup; user can override via env if needed.
  "claude";

export const PORT = Number(process.env.PORT ?? 4000);

// ---- Telegram bot (optional) ----
// When TELEGRAM_BOT_TOKEN is set, the server starts a long-polling bot that
// turns whitelisted users' messages into tickets and starts Director runs.
// Replies (ack + final status) go back to the originating chat.
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
/** Comma-separated whitelist of Telegram user ids (numeric) allowed to use
 *  the bot. Empty = bot stays disabled (don't open ticket creation to the
 *  public Telegram by accident). */
export const TELEGRAM_ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
/** Default project id new tickets go into when the user doesn't prefix the
 *  message with @<project>. Falls back to the first project if unset. */
export const TELEGRAM_DEFAULT_PROJECT_ID = process.env.TELEGRAM_DEFAULT_PROJECT_ID ?? "";
/** Optional. If set and the project has a Playbook with this name, the
 *  ticket is created with triage_notes hinting Director to pick it. */
export const TELEGRAM_DEFAULT_PLAYBOOK = process.env.TELEGRAM_DEFAULT_PLAYBOOK ?? "small_change";
/** Optional. Output / notification chat. If set, run completion summaries
 *  are posted here instead of replying in the original input chat. Lets the
 *  user keep the conversational chat clean — input vs output split. Get the
 *  numeric chat id by adding the bot to a group / channel and sending /list
 *  there; the bot logs the chat id. */
export const TELEGRAM_OUTPUT_CHAT_ID = process.env.TELEGRAM_OUTPUT_CHAT_ID ?? "";

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}
