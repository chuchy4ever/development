/**
 * Telegram bot — long-polling input handler that turns messages from
 * whitelisted users into tickets and starts Director runs.
 *
 * Activation: opt-in via TELEGRAM_BOT_TOKEN env. If unset, the module is
 * inert. We deliberately fail closed: if TELEGRAM_ALLOWED_USER_IDS is
 * empty, the bot logs a warning and refuses every message — better than
 * exposing ticket creation to the open internet by accident.
 *
 * Flow:
 *   user message → whitelist check → create ticket (default project,
 *   default playbook hint in triage_notes) → startRun → reply ack →
 *   poll run state → reply final summary on terminal status.
 *
 * Message format:
 *   First line   = ticket title (cap 200 chars)
 *   Rest of body = ticket body
 *   Optional first line prefix `@projectKey` (case-insensitive match
 *   against project key_prefix) selects a non-default project.
 *
 * Commands:
 *   /help    quick usage info
 *   /list    last 5 active runs across all projects you can write to
 */

import { db, nowIso } from "./db.js";
import { loadProjectWithRepos, loadTicket } from "./store.js";
import { startRun } from "./runs.js";
import { allocateTicketKey } from "./backfillTicketKeys.js";
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_IDS,
  TELEGRAM_DEFAULT_PROJECT_ID,
  TELEGRAM_DEFAULT_PLAYBOOK,
} from "./config.js";
import { nanoid } from "nanoid";

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
}

const API_BASE = () => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tg<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? "error"}`);
  return json.result as T;
}

async function sendMessage(chatId: number, text: string, replyTo?: number): Promise<TgMessage> {
  return tg<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_to_message_id: replyTo,
    disable_web_page_preview: true,
  });
}

function isAllowed(userId: number | undefined): boolean {
  if (!userId) return false;
  if (TELEGRAM_ALLOWED_USER_IDS.length === 0) return false;
  return TELEGRAM_ALLOWED_USER_IDS.includes(String(userId));
}

function pickProject(text: string): { projectId: string | null; rest: string } {
  // Optional `@<key>` prefix on the first line.
  const m = text.match(/^@([a-z0-9_-]+)\s+/i);
  if (m) {
    const prefix = m[1]!.toUpperCase();
    const row = db
      .prepare("SELECT id FROM projects WHERE upper(key_prefix) = ? LIMIT 1")
      .get(prefix) as { id: string } | undefined;
    if (row) return { projectId: row.id, rest: text.slice(m[0].length) };
  }
  return { projectId: TELEGRAM_DEFAULT_PROJECT_ID || null, rest: text };
}

function splitTitleBody(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  const title = (lines[0] ?? "").slice(0, 200).trim();
  const body = lines.slice(1).join("\n").trim();
  return { title, body };
}

async function handleNewTicket(msg: TgMessage, raw: string): Promise<void> {
  const { projectId: pickedId, rest } = pickProject(raw);
  // Resolve effective project id (picked → env default → first project).
  let projectId = pickedId;
  if (!projectId) {
    const row = db.prepare("SELECT id FROM projects ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    projectId = row?.id ?? null;
  }
  if (!projectId) {
    await sendMessage(msg.chat.id, "❌ No projects configured on this server yet.", msg.message_id);
    return;
  }
  const project = loadProjectWithRepos(projectId);
  if (!project) {
    await sendMessage(msg.chat.id, `❌ Project not found.`, msg.message_id);
    return;
  }
  const { title, body } = splitTitleBody(rest);
  if (!title) {
    await sendMessage(msg.chat.id, "❌ Empty message — first line is the ticket title.", msg.message_id);
    return;
  }

  // Insert ticket. If the configured default playbook exists on the project,
  // surface it as a hint in triage_notes — Director reads this on the first
  // turn alongside the playbook registry.
  const playbookHint = TELEGRAM_DEFAULT_PLAYBOOK
    && (project.workflow.playbooks ?? []).some((pb) => pb.name === TELEGRAM_DEFAULT_PLAYBOOK)
    ? `From Telegram. Suggested playbook: ${TELEGRAM_DEFAULT_PLAYBOOK}.`
    : "From Telegram (urgent fast-fix).";

  const ticketId = nanoid(10);
  const now = nowIso();
  const ticketKey = allocateTicketKey(projectId);
  db.prepare(
    `INSERT INTO tickets
       (id, project_id, ticket_key, title, body, status, priority, repos_touched, depends_on, triage_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbox', 'P0', '[]', '[]', ?, ?, ?)`,
  ).run(ticketId, projectId, ticketKey, title, body, playbookHint, now, now);

  const ticket = loadTicket(ticketId);
  if (!ticket) {
    await sendMessage(msg.chat.id, "❌ Failed to load ticket after insert.", msg.message_id);
    return;
  }

  let runId: string;
  try {
    runId = await startRun({ project, ticket });
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e);
    await sendMessage(msg.chat.id, `⚠ Ticket *${ticketKey}* created but run failed to start:\n${m}`, msg.message_id);
    return;
  }

  await sendMessage(
    msg.chat.id,
    `✅ Ticket *${ticketKey}* created\n_${title}_\n\nRun *${runId.slice(0, 8)}* started — I'll DM you when it's done.`,
    msg.message_id,
  );

  // Watch the run's final state and post a summary. Polls db every 5s; up to
  // 30 min before giving up (a runaway run will be reported as still-running).
  watchRunCompletion(runId, msg.chat.id, msg.message_id, ticketKey).catch((e) => {
    console.error("[telegram] watchRunCompletion failed", e);
  });
}

async function watchRunCompletion(
  runId: string,
  chatId: number,
  replyTo: number,
  ticketKey: string | null,
): Promise<void> {
  const TERMINAL = new Set(["succeeded", "failed", "cancelled", "awaiting_approval"]);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const row = db
      .prepare("SELECT status, total_cost_usd, error FROM runs WHERE id = ?")
      .get(runId) as { status: string; total_cost_usd: number | null; error: string | null } | undefined;
    if (!row) return;
    if (TERMINAL.has(row.status)) {
      const cost = row.total_cost_usd ? `$${row.total_cost_usd.toFixed(2)}` : "?";
      const emoji = row.status === "succeeded" ? "✅" : row.status === "awaiting_approval" ? "⏸" : "❌";
      const detail = row.status === "failed" && row.error ? `\nReason: ${row.error.slice(0, 200)}` : "";
      await sendMessage(
        chatId,
        `${emoji} *${ticketKey ?? runId.slice(0, 8)}* — ${row.status} (${cost})${detail}`,
        replyTo,
      );
      return;
    }
  }
  // Timeout — post one heads-up.
  await sendMessage(chatId, `⏱ ${ticketKey ?? runId.slice(0, 8)} still running after 30 min — check the UI.`, replyTo);
}

async function handleHelp(chatId: number, replyTo: number): Promise<void> {
  await sendMessage(chatId, [
    "*ceo bot*",
    "Send a plain message — first line becomes the ticket title, the rest the body.",
    "Prefix with `@AGA` (project key) to target a specific project; default is configured server-side.",
    "",
    "Commands:",
    "  /help — this message",
    "  /list — recent active runs",
  ].join("\n"), replyTo);
}

async function handleList(chatId: number, replyTo: number): Promise<void> {
  const rows = db.prepare(
    `SELECT r.id, r.status, r.total_cost_usd, t.ticket_key, t.title
       FROM runs r
       LEFT JOIN tickets t ON t.id = r.ticket_id
      WHERE r.status IN ('running', 'pending', 'awaiting_approval')
      ORDER BY r.created_at DESC
      LIMIT 5`,
  ).all() as { id: string; status: string; total_cost_usd: number | null; ticket_key: string | null; title: string }[];
  if (rows.length === 0) {
    await sendMessage(chatId, "No active runs.", replyTo);
    return;
  }
  const lines = rows.map((r) => {
    const cost = r.total_cost_usd ? `$${r.total_cost_usd.toFixed(2)}` : "$?";
    return `• *${r.ticket_key ?? r.id.slice(0, 6)}* — ${r.status} ${cost}\n  _${r.title.slice(0, 60)}_`;
  });
  await sendMessage(chatId, lines.join("\n"), replyTo);
}

async function handleMessage(msg: TgMessage): Promise<void> {
  const text = msg.text?.trim() ?? "";
  if (!text) return;
  const userId = msg.from?.id;
  if (!isAllowed(userId)) {
    await sendMessage(msg.chat.id, `🚫 User ${userId ?? "?"} not in TELEGRAM_ALLOWED_USER_IDS whitelist.`, msg.message_id);
    return;
  }
  if (text.startsWith("/help") || text === "/start") return handleHelp(msg.chat.id, msg.message_id);
  if (text.startsWith("/list")) return handleList(msg.chat.id, msg.message_id);
  if (text.startsWith("/")) {
    await sendMessage(msg.chat.id, "Unknown command. Try /help.", msg.message_id);
    return;
  }
  await handleNewTicket(msg, text);
}

let pollLoopRunning = false;

/** Start the bot. Safe to call multiple times — second call is a no-op. */
export function startTelegramBot(): void {
  if (!TELEGRAM_BOT_TOKEN) {
    return; // not configured — silent
  }
  if (pollLoopRunning) return;
  pollLoopRunning = true;

  if (TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    console.warn("[telegram] WARNING: TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_USER_IDS is empty — bot will reject every message.");
  }

  console.log("[telegram] long-poll bot starting...");
  void runPollLoop();
}

async function runPollLoop(): Promise<void> {
  // Persist offset so we don't re-process old updates after a restart.
  let offset = (() => {
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = 'telegram.offset'").get() as { value: string } | undefined;
      return row ? Number(row.value) : 0;
    } catch { return 0; }
  })();
  // Ensure kv table exists (used as a tiny key-value blob store).
  try {
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  } catch { /* ignore */ }

  while (pollLoopRunning) {
    try {
      const updates = await tg<TgUpdate[]>("getUpdates", {
        offset,
        timeout: 25, // long-poll
        allowed_updates: ["message"],
      });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const msg = u.message ?? u.edited_message;
        if (msg) {
          handleMessage(msg).catch((e) => {
            console.error("[telegram] handleMessage error", e);
          });
        }
      }
      if (updates.length > 0) {
        db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('telegram.offset', ?)").run(String(offset));
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      console.error("[telegram] poll error:", m);
      // Back off after errors so we don't hammer the API on persistent failure.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
