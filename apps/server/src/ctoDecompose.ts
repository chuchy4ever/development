import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import type { ProjectWithRepos, Ticket } from "@ceo/shared";
import { db, nowIso } from "./db.js";
import { PROJECTS_DIR } from "./config.js";
import { runAgentOneShot } from "./oneShot.js";
import { extractJsonWithFallback } from "./jsonUtil.js";
import { extractCostFromStdout, recordCost } from "./costLog.js";
import { loadTicket } from "./store.js";
import { allocateTicketKey } from "./backfillTicketKeys.js";
import { AGENT_NAMES } from "./defaultAgents.js";

interface CtoSubtask {
  title: string;
  body: string;
  depends_on_indices?: number[];
}

interface CtoDecomposeOutput {
  decompose: boolean;
  rationale: string;
  subtasks: CtoSubtask[];
}

export interface DecomposeResult {
  decomposed: boolean;
  rationale: string;
  created: Ticket[];
}

export async function decomposeTicket(
  project: ProjectWithRepos,
  ticket: Ticket,
  /** When set, CTO's claude cost is attributed to this director run. */
  runId?: string | null,
): Promise<DecomposeResult> {
  const cto = project.agents.find((a) => a.name === AGENT_NAMES.CTO);
  if (!cto) {
    throw new Error(
      "no CTO agent in this project — add one from templates (Agents tab → Add from template → CTO)",
    );
  }

  const repoList = project.repos.length > 0
    ? project.repos.map((r) => `- ${r.name}: ./${r.name}/`).join("\n")
    : "(no repos configured)";

  const prompt = `# Project: ${project.name}

${project.description || ""}

## Spec
${project.spec_md || "(none)"}

## Tech stack
${project.tech_stack_md || "(none)"}

## Repos available (read-only access via Read/Grep/Glob)
${repoList}

---

# Ticket: ${ticket.title}
${ticket.body || "(no body)"}

${ticket.triage_notes ? `## Triage notes\n${ticket.triage_notes}\n` : ""}

---

Decide whether to decompose. If yes, produce ordered subtasks. End with the JSON object as specified in your role.`;

  // CTO works in the project's repos directory (parent of all clones), read-only.
  const cwd = path.join(PROJECTS_DIR, project.id, "repos");
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }

  const res = await runAgentOneShot(cto, prompt, cwd);
  recordCost({
    source: "cto_decompose",
    cost_usd: extractCostFromStdout(res.stdout),
    project_id: project.id,
    run_id: runId ?? null,
  });
  const parsed = extractJsonWithFallback<CtoDecomposeOutput>(res.stdout);
  if (!parsed) {
    throw new Error(`CTO returned unparseable output: ${res.stdout.slice(0, 500)}`);
  }

  if (!parsed.decompose || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
    return { decomposed: false, rationale: parsed.rationale ?? "", created: [] };
  }

  const created: Ticket[] = [];
  const idsByIndex: string[] = [];
  const insert = db.prepare(
    `INSERT INTO tickets
       (id, project_id, ticket_key, title, body, status, repos_touched, depends_on, parent_ticket_id, triage_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < parsed.subtasks.length; i++) {
    const s = parsed.subtasks[i]!;
    const id = nanoid(10);
    const key = allocateTicketKey(project.id);
    const now = nowIso();
    const dependsOnIds = (s.depends_on_indices ?? [])
      .map((idx) => idsByIndex[idx])
      .filter((x): x is string => typeof x === "string");
    insert.run(
      id,
      project.id,
      key,
      s.title.trim().slice(0, 200),
      s.body ?? "",
      JSON.stringify(ticket.repos_touched),
      JSON.stringify(dependsOnIds),
      ticket.id,
      `Decomposed by CTO from ticket "${ticket.title}".`,
      now,
      now,
    );
    idsByIndex[i] = id;
    const t = loadTicket(id);
    if (t) created.push(t);
  }

  // Optionally mark parent as blocked while children run.
  db.prepare(`UPDATE tickets SET status = 'blocked', updated_at = ? WHERE id = ?`)
    .run(nowIso(), ticket.id);

  return { decomposed: true, rationale: parsed.rationale ?? "", created };
}
