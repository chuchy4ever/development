import type { TaskExecutor, TaskVerdict } from "./types.js";
import { type Trigger, TRIGGER_VALUES, shouldFire, buildVars, render } from "./connectorShared.js";

interface TelegramConfig {
  /** Bot token (e.g. "1234567:AAH..."). Stored in workflow JSON — keep workflow private. */
  bot_token: string;
  chat_id: string | number;
  /** Message template. Placeholders: {ticket_key} {ticket_title} {project_name} {run_id} {verdict_summary} {verdict_status} */
  template: string;
  /** When to actually send. Defaults to "always". */
  on?: Trigger;
  /** "Markdown" | "MarkdownV2" | "HTML" | "" (none). Defaults to "Markdown". */
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML" | "";
}

export const telegramExecutor: TaskExecutor = {
  type: "telegram",

  validate(config) {
    const c = config as Partial<TelegramConfig>;
    if (!c.bot_token || typeof c.bot_token !== "string") return "telegram: 'bot_token' is required";
    if (c.chat_id === undefined || c.chat_id === null || c.chat_id === "")
      return "telegram: 'chat_id' is required";
    if (!c.template || typeof c.template !== "string")
      return "telegram: 'template' is required";
    if (c.on !== undefined && !(TRIGGER_VALUES as readonly string[]).includes(c.on))
      return `telegram: 'on' must be one of ${TRIGGER_VALUES.join(", ")}`;
    if (c.parse_mode !== undefined && !["Markdown", "MarkdownV2", "HTML", ""].includes(c.parse_mode))
      return "telegram: 'parse_mode' must be 'Markdown', 'MarkdownV2', 'HTML' or ''";
    return null;
  },

  async run(config, ctx) {
    const c = config as unknown as TelegramConfig;
    const on: Trigger = c.on ?? "always";
    if (!shouldFire(on, ctx.lastWasFailure)) {
      return {
        ok: true,
        summary: `telegram: skipped (on=${on}, ${ctx.lastWasFailure ? "previous failed" : "previous ok"})`,
        issues: [],
      };
    }

    const text = render(c.template, buildVars(ctx));

    const url = `https://api.telegram.org/bot${encodeURIComponent(c.bot_token)}/sendMessage`;
    const body = {
      chat_id: c.chat_id,
      text,
      ...(c.parse_mode ? { parse_mode: c.parse_mode } : {}),
      disable_web_page_preview: true,
    };

    ctx.emit("command_start", {
      phase_id: ctx.phase.id,
      command: `telegram → chat ${c.chat_id}`,
      // Don't echo the token.
    });

    let cancelled = false;
    const controller = new AbortController();
    ctx.registerCancel(() => { cancelled = true; controller.abort(); });

    let httpStatus = 0;
    let responseText = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      httpStatus = res.status;
      responseText = await res.text();
    } catch (e: any) {
      ctx.unregisterCancel();
      const msg = cancelled ? "cancelled by user" : (e?.message ?? String(e));
      const verdict: TaskVerdict = {
        ok: false,
        summary: `telegram: request failed — ${msg}`,
        issues: [msg],
        details: "",
      };
      ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: -1, cancelled });
      return verdict;
    }
    ctx.unregisterCancel();

    const ok = httpStatus >= 200 && httpStatus < 300;
    const issues: string[] = [];
    if (!ok) {
      issues.push(`HTTP ${httpStatus}`);
      const tail = responseText.length > 400 ? responseText.slice(0, 400) + "…" : responseText;
      if (tail) issues.push(tail);
    }

    ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: ok ? 0 : 1, http_status: httpStatus });

    return {
      ok,
      summary: ok
        ? `telegram → chat ${c.chat_id} (HTTP ${httpStatus})`
        : `telegram → HTTP ${httpStatus}`,
      issues,
      details: responseText.slice(0, 4096),
      http_status: httpStatus,
    };
  },
};
