/**
 * Outbound Telegram messaging — extracted so non-bot modules (scheduled jobs,
 * digests, alerts) can post without pulling in the long-poll bot's wiring.
 *
 * If TELEGRAM_BOT_TOKEN is unset, send is a no-op that returns false. Callers
 * don't need to special-case the disabled state.
 */

import { TELEGRAM_BOT_TOKEN } from "./config.js";

const API_BASE = () => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

interface TgResult { ok: boolean; description?: string }

/** POST to the Telegram bot API. Throws on transport / API failure. */
export async function tg<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`${API_BASE()}/${method}`, {
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
  if (!TELEGRAM_BOT_TOKEN) return false;
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
