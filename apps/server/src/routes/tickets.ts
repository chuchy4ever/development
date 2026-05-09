import { Router } from "express";
import { nanoid } from "nanoid";
import { db, nowIso } from "../db.js";
import { runTriage } from "../triage.js";
import { deleteRunsForTicket } from "../runs.js";
import { listTicketsForProject, loadProjectWithRepos, loadTicket } from "../store.js";
import { bulkCreateTickets, parseMarkdownTickets } from "../bulkImport.js";
import { decomposeTicket } from "../ctoDecompose.js";
import { allocateTicketKey } from "../backfillTicketKeys.js";
import type { BulkImportInput, BulkImportResult, CreateTicketInput, Ticket } from "@ceo/shared";

export const ticketsRouter = Router({ mergeParams: true });

function projectIdFrom(req: { params: Record<string, string | undefined> }): string {
  return req.params.projectId!;
}

ticketsRouter.get("/", (req, res) => {
  res.json(listTicketsForProject(projectIdFrom(req)));
});

ticketsRouter.post("/", (req, res) => {
  const projectId = projectIdFrom(req);
  const input = req.body as CreateTicketInput;
  if (!input?.title?.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  const id = nanoid(10);
  const now = nowIso();
  const ticketKey = allocateTicketKey(projectId);
  db.prepare(
    `INSERT INTO tickets
       (id, project_id, ticket_key, title, body, status, repos_touched, depends_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbox', '[]', '[]', ?, ?)`,
  ).run(id, projectId, ticketKey, input.title.trim(), input.body ?? "", now, now);
  res.status(201).json(loadTicket(id));
});

ticketsRouter.post("/bulk", async (req, res) => {
  const projectId = projectIdFrom(req);
  const input = req.body as BulkImportInput;
  if (typeof input?.markdown !== "string" || !input.markdown.trim()) {
    return res.status(400).json({ error: "markdown is required" });
  }
  const parsed = parseMarkdownTickets(input.markdown);
  if (parsed.length === 0) {
    return res.status(400).json({ error: "no tickets parsed from input" });
  }
  const created = bulkCreateTickets(projectId, parsed);

  let triaged = 0;
  if (input.auto_triage) {
    const project = loadProjectWithRepos(projectId);
    if (project) {
      // Triage in parallel but cap concurrency to avoid hammering the API.
      const limit = 3;
      for (let i = 0; i < created.length; i += limit) {
        const slice = created.slice(i, i + limit);
        await Promise.all(
          slice.map(async (t) => {
            try {
              const v = await runTriage(project, t);
              const now = nowIso();
              db.prepare(
                `UPDATE tickets
                   SET priority = ?,
                       workflow_template = ?,
                       repos_touched = ?,
                       triage_notes = ?,
                       status = 'backlog',
                       updated_at = ?
                 WHERE id = ?`,
              ).run(v.priority, v.workflow_template, JSON.stringify(v.repos_touched), v.notes, now, t.id);
              triaged++;
            } catch {
              // Leave in inbox; user can manually triage.
            }
          }),
        );
      }
    }
  }

  const result: BulkImportResult = {
    created: created.map((t) => loadTicket(t.id)!).filter(Boolean),
    triaged,
  };
  res.status(201).json(result);
});

ticketsRouter.patch("/:id", (req, res) => {
  if (!loadTicket(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  const input = req.body as Partial<Ticket>;
  db.prepare(
    `UPDATE tickets
       SET title = COALESCE(?, title),
           body = COALESCE(?, body),
           status = COALESCE(?, status),
           priority = COALESCE(?, priority),
           workflow_template = COALESCE(?, workflow_template),
           repos_touched = COALESCE(?, repos_touched),
           depends_on = COALESCE(?, depends_on),
           triage_notes = COALESCE(?, triage_notes),
           updated_at = ?
     WHERE id = ?`,
  ).run(
    input.title ?? null,
    input.body ?? null,
    input.status ?? null,
    input.priority ?? null,
    input.workflow_template ?? null,
    input.repos_touched ? JSON.stringify(input.repos_touched) : null,
    input.depends_on ? JSON.stringify(input.depends_on) : null,
    input.triage_notes ?? null,
    nowIso(),
    req.params.id,
  );
  res.json(loadTicket(req.params.id));
});

ticketsRouter.delete("/:id", async (req, res) => {
  const ticket = loadTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: "not found" });
  await deleteRunsForTicket(ticket.id);
  db.prepare("DELETE FROM tickets WHERE id = ?").run(ticket.id);
  res.status(204).end();
});

ticketsRouter.post("/:id/decompose", async (req, res) => {
  const projectId = projectIdFrom(req);
  const ticket = loadTicket(req.params.id);
  if (!ticket || ticket.project_id !== projectId) {
    return res.status(404).json({ error: "ticket not found" });
  }
  const project = loadProjectWithRepos(projectId);
  if (!project) return res.status(404).json({ error: "project not found" });
  try {
    const result = await decomposeTicket(project, ticket);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

ticketsRouter.post("/:id/triage", async (req, res) => {
  const projectId = projectIdFrom(req);
  const ticket = loadTicket(req.params.id);
  if (!ticket || ticket.project_id !== projectId) {
    return res.status(404).json({ error: "ticket not found" });
  }
  const project = loadProjectWithRepos(projectId);
  if (!project) return res.status(404).json({ error: "project not found" });

  try {
    const triage = await runTriage(project, ticket);
    db.prepare(
      `UPDATE tickets
         SET priority = ?,
             workflow_template = ?,
             repos_touched = ?,
             triage_notes = ?,
             status = CASE WHEN status = 'inbox' THEN 'backlog' ELSE status END,
             updated_at = ?
       WHERE id = ?`,
    ).run(
      triage.priority,
      triage.workflow_template,
      JSON.stringify(triage.repos_touched),
      triage.notes,
      nowIso(),
      ticket.id,
    );
    res.json(loadTicket(ticket.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});
