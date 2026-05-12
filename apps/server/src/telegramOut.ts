/**
 * Outbound Telegram messaging — extracted so non-bot modules (scheduled jobs,
 * digests, alerts) can post without pulling in the long-poll bot's wiring.
 *
 * Resolves the bot token live from global_secrets (admin UI) → env fallback,
 * so adding the token via UI takes effect on the next send without a restart.
 * The long-polling bot itself still needs a restart to (re)connect.
 */

import { getGlobalSecret } from "./globalSecrets.js";

function botToken(): string {
  return getGlobalSecret("telegram_bot_token");
}

const API_BASE = (token: string) => `https://api.telegram.org/bot${token}`;

interface TgResult { ok: boolean; description?: string }

/** POST to the Telegram bot API. Throws on transport / API failure. */
export async function tg<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
  const token = botToken();
  if (!token) throw new Error("telegram_bot_token not set (admin → secrets, or TELEGRAM_BOT_TOKEN env)");
  const res = await fetch(`${API_BASE(token)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as TgResult & { result?: T };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? "error"}`);
  return json.result as T;
}

/**
 * Send a message to a chat. Tries Markdown first; on parse failure (unbalanced
 * underscores in user-supplied content like errors / IDs) falls back to plain
 * text so the message still gets through.
 *
 * Returns true on success, false if the bot is not configured.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  opts: { replyTo?: number } = {},
): Promise<boolean> {
  if (!botToken()) return false;
  try {
    await tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_to_message_id: opts.replyTo,
      disable_web_page_preview: true,
    });
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/can't parse entities/i.test(msg)) throw e;
    await tg("sendMessage", {
      chat_id: chatId,
      text,
      reply_to_message_id: opts.replyTo,
      disable_web_page_preview: true,
    });
    return true;
  }
}
