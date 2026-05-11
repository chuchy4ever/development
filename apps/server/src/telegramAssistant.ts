/**
 * Telegram CEO assistant — conversational layer that sits in front of the
 * raw "message → ticket" flow.
 *
 * The user chats freely; the assistant has read access to the current state
 * (projects, active runs, recent costs) and can dispatch new tickets when
 * the user gives clear instructions. It is NOT the Director — Director runs
 * inside a single ticket. This is a chat-level helper.
 *
 * Pattern (single-turn-per-message, multi-turn-per-conversation):
 *  1. User sends a message.
 *  2. Server appends to per-chat history (capped, persisted in `kv` table).
 *  3. Server invokes claude CLI with system prompt + state snapshot +
 *     last N turns + new user message.
 *  4. Claude replies in markdown. If the reply ends with a `CREATE_TICKET`
 *     marker block, the server parses it, creates the ticket, starts a
 *     Director run, and posts a confirmation in the same chat.
 *  5. The assistant's reply (without the marker) is sent back to Telegram.
 *
 * Why no tool loop: keeps latency and complexity low; the state snapshot
 * is rebuilt fresh each turn. If the user asks for something the snapshot
 * doesn't cover, they get a "I don't see that — can you clarify?" reply.
 */

import { db, nowIso } from "./db.js";
import { loadProjectWithRepos, loadTicket, listProjects } from "./store.js";
import { startRun } from "./runs.js";
import { allocateTicketKey } from "./backfillTicketKeys.js";
import { streamClaude } from "./claude.js";
import { extractCostFromStdout, recordCost } from "./costLog.js";
import { nanoid } from "nanoid";

const ASSISTANT_MODEL = "claude-sonnet-4-6";
const MAX_HISTORY_TURNS = 20;
const MARKER_RE = /(?:^|\n)CREATE_TICKET:\s*([a-z0-9_-]+)\s*:\s*([^\n]+)\n([\s\S]*)$/i;
const JOB_MARKER_RE = /(?:^|\n)CREATE_JOB:\s*\n?(\{[\s\S]*\})\s*$/;

interface Turn {
  role: "user" | "assistant";
  text: string;
}

function loadHistory(chatId: number): Turn[] {
  ensureKvTable();
  const row = db
    .prepare("SELECT value FROM kv WHERE key = ?")
    .get(`telegram.history.${chatId}`) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as Turn[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY_TURNS) : [];
  } catch {
    return [];
  }
}

function saveHistory(chatId: number, turns: Turn[]): void {
  const trimmed = turns.slice(-MAX_HISTORY_TURNS);
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
    .run(`telegram.history.${chatId}`, JSON.stringify(trimmed));
}

let kvEnsured = false;
function ensureKvTable(): void {
  if (kvEnsured) return;
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  kvEnsured = true;
}

export function clearHistory(chatId: number): void {
  ensureKvTable();
  db.prepare("DELETE FROM kv WHERE key = ?").run(`telegram.history.${chatId}`);
}

interface StateSnapshot {
  projects: { id: string; name: string; key_prefix: string; tickets: number; runs: number; spent: number }[];
  activeRuns: { run_id: string; ticket_key: string | null; ticket_title: string; agent: string; status: string }[];
  recentRuns: { ticket_key: string | null; status: string; cost: number; finished_at: string | null }[];
  jobs: { name: string; kind: string; schedule: string; next_run_at: string | null; enabled: boolean }[];
}

function snapshotState(): StateSnapshot {
  // One pass per category, all aggregated in SQL where possible. Cheap on a
  // single-user instance; would want to cache for high-traffic.
  const projectsRaw = listProjects();
  const projects = projectsRaw.map((p) => {
    const ticketCount = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE project_id = ?").get(p.id) as { n: number }).n;
    const runRow = db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd), 0) AS s FROM runs WHERE project_id = ?",
    ).get(p.id) as { n: number; s: number };
    return {
      id: p.id,
      name: p.name,
      key_prefix: p.key_prefix,
      tickets: ticketCount,
      runs: runRow.n,
      spent: +runRow.s.toFixed(2),
    };
  });
  const active = db.prepare(
    `SELECT r.id AS run_id, r.status, r.current_agent_name AS agent,
            t.ticket_key AS ticket_key, t.title AS ticket_title
       FROM runs r LEFT JOIN tickets t ON t.id = r.ticket_id
      WHERE r.status IN ('pending', 'running', 'awaiting_approval')
      ORDER BY r.created_at DESC LIMIT 10`,
  ).all() as StateSnapshot["activeRuns"];
  const recent = db.prepare(
    `SELECT t.ticket_key AS ticket_key, r.status, r.total_cost_usd AS cost, r.finished_at
       FROM runs r LEFT JOIN tickets t ON t.id = r.ticket_id
      WHERE r.status IN ('succeeded', 'failed', 'cancelled')
      ORDER BY r.finished_at DESC LIMIT 5`,
  ).all() as { ticket_key: string | null; status: string; cost: number | null; finished_at: string | null }[];
  const jobsRaw = db.prepare(
    `SELECT name, kind, schedule, next_run_at, enabled FROM scheduled_jobs ORDER BY enabled DESC, COALESCE(next_run_at, '9999') ASC LIMIT 10`,
  ).all() as { name: string; kind: string; schedule: string; next_run_at: string | null; enabled: number }[];
  return {
    projects,
    activeRuns: active,
    recentRuns: recent.map((r) => ({ ticket_key: r.ticket_key, status: r.status, cost: r.cost ?? 0, finished_at: r.finished_at })),
    jobs: jobsRaw.map((j) => ({ name: j.name, kind: j.kind, schedule: j.schedule, next_run_at: j.next_run_at, enabled: !!j.enabled })),
  };
}

function renderState(s: StateSnapshot): string {
  const parts: string[] = [];
  parts.push("## Projects");
  if (s.projects.length === 0) parts.push("(none)");
  else for (const p of s.projects) {
    parts.push(`- **${p.key_prefix}** ${p.name} — ${p.tickets} tickets, ${p.runs} runs, $${p.spent.toFixed(2)} spent`);
  }
  parts.push("");
  parts.push("## Active runs");
  if (s.activeRuns.length === 0) parts.push("(none)");
  else for (const r of s.activeRuns) {
    parts.push(`- ${r.ticket_key ?? r.run_id.slice(0, 6)} — ${r.status} (agent: ${r.agent ?? "?"}) — _${r.ticket_title.slice(0, 60)}_`);
  }
  parts.push("");
  parts.push("## Recent completed runs (last 5)");
  if (s.recentRuns.length === 0) parts.push("(none)");
  else for (const r of s.recentRuns) {
    parts.push(`- ${r.ticket_key ?? "?"} — ${r.status} — $${r.cost.toFixed(2)}`);
  }
  parts.push("");
  parts.push("## Scheduled jobs");
  if (s.jobs.length === 0) parts.push("(none)");
  else for (const j of s.jobs) {
    const status = j.enabled ? "✅" : "⏸";
    const next = j.next_run_at ? new Date(j.next_run_at).toISOString().slice(0, 16).replace("T", " ") : "—";
    parts.push(`- ${status} **${j.name}** (${j.kind}) — \`${j.schedule}\` — next: ${next}`);
  }
  return parts.join("\n");
}

function buildSystemPrompt(state: StateSnapshot): string {
  return `You are the ceo CEO assistant — a chat-level helper for a single user (the principal of this software-engineering automation tool). The user reaches you via Telegram and wants to:
- Ask about state (projects, runs, costs, recent activity).
- Refine task ideas through conversation.
- Dispatch new tickets into projects when ready.

You are NOT the Director. The Director runs inside a single ticket and orchestrates sub-agents. You sit one level above: you help the user shape ideas into well-specified tickets, then hand off to Director by creating one.

## Current state

${renderState(state)}

## Available action 1: dispatch a ticket

When (and only when) the user asks you to create + start a ticket, end your reply with this exact marker block on its own paragraph (NO code fence — just the literal text):

CREATE_TICKET:<PROJECT_KEY>:<short title — one line, max 100 chars>
<body — multiple lines, full ticket spec: acceptance criteria, files, hints, etc.>

The marker MUST be the LAST thing in your reply. Anything before it is shown to the user as your normal reply. PROJECT_KEY is the short prefix from the projects list above (e.g. AGA). Director-runs auto-start; user gets a confirmation message separately.

If the request is ambiguous (target project unclear, scope vague, body too thin), DO NOT emit the marker — instead, reply asking the clarifying question. Quality of the spec matters more than speed.

## Available action 2: schedule a job

When the user asks to set up something recurring or deferred ("every Monday at 9 send a digest", "next Friday create a deploy ticket", "pause the scheduler at night"), end your reply with this marker (also LAST thing in the reply, no code fence):

CREATE_JOB:
{"name":"<short label>","kind":"ticket|digest|scheduler_mode","schedule":"<cron or @once:<ISO>>","project_key":"<KEY or null>","payload":{...}}

Schedule syntax:
- 5-field cron ("0 9 * * 1" = Monday 09:00 server time; "*/30 * * * *" = every 30 min)
- "@once:2026-12-01T09:00:00Z" for one-shot

Payload by kind:
- ticket:   {"kind":"ticket","title":"...","body":"...","priority":"P0|P1|P2|P3","auto_start":true|false}  — project_key REQUIRED
- digest:   {"kind":"digest","lookback_hours":24}  — pushes stats to TELEGRAM_OUTPUT_CHAT_ID; project_key optional (null = all projects)
- scheduler_mode: {"kind":"scheduler_mode","mode":"running"|"paused"}  — project_key must be null (global)

Emit at most ONE marker per reply (either CREATE_TICKET or CREATE_JOB, not both). For ambiguous requests, ask for clarification first.

## Reply rules

- Markdown formatting (bold, lists, code) is fine — Telegram renders it.
- Keep replies short by default — this is a chat, not an essay. 1–6 sentences unless the user asked for detail.
- When the user just chats / asks a question: reply with no marker.
- When the user says "do it" / "ship it" / "create the ticket": emit the marker.
- Czech and English both fine; match the user's language.
- Never invent state — if the user asks about a project / ticket / run not in the snapshot above, say you don't see it.`;
}

interface DispatchResult {
  ticketKey: string;
  runId: string;
}

async function dispatchTicket(
  projectKey: string,
  title: string,
  body: string,
): Promise<DispatchResult | { error: string }> {
  const project = listProjects().find((p) => p.key_prefix.toUpperCase() === projectKey.toUpperCase());
  if (!project) return { error: `Project "${projectKey}" not found.` };
  const projectFull = loadProjectWithRepos(project.id);
  if (!projectFull) return { error: `Project "${projectKey}" load failed.` };

  const ticketId = nanoid(10);
  const now = nowIso();
  const ticketKey = allocateTicketKey(project.id);
  db.prepare(
    `INSERT INTO tickets
       (id, project_id, ticket_key, title, body, status, priority, repos_touched, depends_on, triage_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbox', 'P0', '[]', '[]', ?, ?, ?)`,
  ).run(ticketId, project.id, ticketKey, title.slice(0, 200), body, "Dispatched via Telegram CEO chat.", now, now);
  const ticket = loadTicket(ticketId);
  if (!ticket) return { error: "Ticket insert succeeded but reload failed." };
  try {
    const runId = await startRun({ project: projectFull, ticket });
    return { ticketKey: ticketKey ?? ticketId.slice(0, 6), runId };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Calls claude with the full conversation + state context. Returns the
 *  assistant's reply text and any parsed dispatch directive. */
async function callAssistant(systemPrompt: string, history: Turn[]): Promise<string> {
  // The CLI takes a single "prompt" string — render the history into one
  // alternating-role transcript. The current user message is the last turn.
  const parts: string[] = [];
  for (const t of history) {
    parts.push(`### ${t.role === "user" ? "User" : "Assistant"}\n${t.text}`);
  }
  parts.push("### Assistant\n");
  const promptStr = parts.join("\n\n");

  let stdoutBuf = "";
  const { promise } = streamClaude(
    {
      prompt: promptStr,
      systemPrompt,
      cwd: process.cwd(),
      model: ASSISTANT_MODEL,
    },
    {
      onLine: (line) => {
        stdoutBuf += line + "\n";
      },
      onStderr: () => {},
    },
  );
  await promise;
  // Conversational assistant has no project / run context — log cost as global.
  recordCost({ source: "telegram_assistant", cost_usd: extractCostFromStdout(stdoutBuf) });
  // claude --output-format stream-json puts the final text in the last
  // assistant message. Walk the stream extracting text blocks.
  const text: string[] = [];
  for (const line of stdoutBuf.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "assistant" && ev.message?.content) {
        for (const c of ev.message.content) {
          if (c?.type === "text" && typeof c.text === "string") text.push(c.text);
        }
      }
    } catch { /* not json */ }
  }
  return text.join("\n").trim();
}

export interface AssistantResponse {
  reply: string;
  dispatch?: DispatchResult;
  dispatchError?: string;
  jobCreated?: { name: string; kind: string; schedule: string; next_run_at: string | null };
  jobError?: string;
}

async function createJobFromMarker(rawJson: string): Promise<{ ok: true; job: { name: string; kind: string; schedule: string; next_run_at: string | null } } | { ok: false; error: string }> {
  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e: unknown) {
    return { ok: false, error: `marker JSON unparseable: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Resolve project_key → project_id (assistant uses the human-readable key).
  let projectId: string | null = null;
  if (parsed.project_key && typeof parsed.project_key === "string") {
    const proj = listProjects().find((p) => p.key_prefix.toUpperCase() === parsed.project_key.toUpperCase());
    if (!proj) return { ok: false, error: `project_key "${parsed.project_key}" not found` };
    projectId = proj.id;
  }
  try {
    const { createJob } = await import("./scheduledJobs.js");
    // Accept either new shape ({trigger, action}) or legacy ({kind, schedule, payload})
    // because assistant prompts in conversation history may still emit the old form.
    const trigger = parsed.trigger ?? { type: "cron", schedule: parsed.schedule };
    const action = parsed.action ?? legacyKindToAction(parsed.kind, parsed.payload ?? {});
    const job = createJob({
      name: String(parsed.name ?? "(unnamed)"),
      project_id: projectId,
      trigger,
      action,
      enabled: parsed.enabled !== false,
    });
    const scheduleStr = job.trigger.type === "cron" ? job.trigger.schedule : job.trigger.poll_schedule;
    return { ok: true, job: { name: job.name, kind: job.action.type, schedule: scheduleStr, next_run_at: job.next_run_at } };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function legacyKindToAction(kind: unknown, payload: Record<string, unknown>): any {
  if (kind === "ticket") {
    return { type: "create_ticket", title: payload.title, body: payload.body, priority: payload.priority, auto_start: !!payload.auto_start };
  }
  if (kind === "digest") {
    return { type: "telegram_digest", chat_id: payload.chat_id, lookback_hours: payload.lookback_hours };
  }
  if (kind === "scheduler_mode") {
    return { type: "scheduler_mode", mode: payload.mode };
  }
  throw new Error(`unknown legacy kind "${String(kind)}"`);
}

/** Public entry. Receives one user message, returns the assistant's reply
 *  and any side-effect (ticket dispatched). */
export async function handleAssistantMessage(
  chatId: number,
  userText: string,
): Promise<AssistantResponse> {
  const history = loadHistory(chatId);
  history.push({ role: "user", text: userText });
  const state = snapshotState();
  const systemPrompt = buildSystemPrompt(state);
  let raw: string;
  try {
    raw = await callAssistant(systemPrompt, history);
  } catch (e: unknown) {
    return { reply: `⚠ Assistant call failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Extract the trailing CREATE_TICKET / CREATE_JOB marker if present (mutually
  // exclusive — assistant prompt asks for at most one).
  let visibleReply = raw;
  let dispatchSpec: { projectKey: string; title: string; body: string } | null = null;
  let jobJson: string | null = null;
  const ticketMatch = raw.match(MARKER_RE);
  const jobMatch = raw.match(JOB_MARKER_RE);
  // Prefer whichever marker comes later in the text (handles a model that
  // emits both — the trailing one wins).
  const ticketIdx = ticketMatch?.index ?? -1;
  const jobIdx = jobMatch?.index ?? -1;
  if (ticketIdx >= 0 && ticketIdx >= jobIdx) {
    dispatchSpec = { projectKey: ticketMatch![1]!.toUpperCase(), title: ticketMatch![2]!.trim(), body: ticketMatch![3]!.trim() };
    visibleReply = raw.slice(0, ticketIdx).trim();
  } else if (jobIdx >= 0) {
    jobJson = jobMatch![1]!;
    visibleReply = raw.slice(0, jobIdx).trim();
  }

  // Persist history with what we'll show; don't store the marker (assistant
  // should re-decide based on fresh state on follow-ups).
  history.push({ role: "assistant", text: visibleReply || "(dispatched action)" });
  saveHistory(chatId, history);

  let dispatch: DispatchResult | undefined;
  let dispatchError: string | undefined;
  if (dispatchSpec) {
    const r = await dispatchTicket(dispatchSpec.projectKey, dispatchSpec.title, dispatchSpec.body);
    if ("error" in r) dispatchError = r.error;
    else dispatch = r;
  }

  let jobCreated: AssistantResponse["jobCreated"];
  let jobError: string | undefined;
  if (jobJson) {
    const r = await createJobFromMarker(jobJson);
    if (r.ok) jobCreated = r.job;
    else jobError = r.error;
  }

  return {
    reply: visibleReply || (dispatch ? `Dispatching *${dispatch.ticketKey}*…` : jobCreated ? `Scheduling *${jobCreated.name}*…` : "(empty reply)"),
    dispatch,
    dispatchError,
    jobCreated,
    jobError,
  };
}
