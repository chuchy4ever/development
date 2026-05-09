import { nanoid } from "nanoid";
import { db, nowIso } from "./db.js";
import { loadTicket } from "./store.js";
import { allocateTicketKey } from "./backfillTicketKeys.js";
import type { Ticket } from "@ceo/shared";

interface ParsedTicket {
  title: string;
  body: string;
}

/**
 * Parse a markdown blob into tickets.
 *
 * Supported formats:
 * 1. Heading-delimited: `## Title\n\nbody...` repeated. Both `#` and `##` work.
 * 2. Bullet list: top-level `- item` lines, each becomes a one-line ticket.
 * 3. Fallback: a single ticket — first non-empty line is title, rest is body.
 */
export function parseMarkdownTickets(md: string): ParsedTicket[] {
  const text = md.trim();
  if (!text) return [];

  // Heading-delimited.
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length > 0) {
    const tickets: ParsedTicket[] = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const titleStart = m.index! + m[0].length;
      const next = matches[i + 1];
      const bodyEnd = next ? next.index! : text.length;
      const title = m[2]!.trim();
      const body = text.slice(titleStart, bodyEnd).trim();
      if (title) tickets.push({ title, body });
    }
    if (tickets.length > 0) return tickets;
  }

  // Bullet list.
  const bulletLines = text
    .split("\n")
    .map((l) => l.match(/^\s*[-*+]\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ title: m[1]!.trim(), body: "" }));
  if (bulletLines.length >= 2) return bulletLines;

  // Single ticket fallback.
  const lines = text.split("\n");
  const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty === -1) return [];
  const title = lines[firstNonEmpty]!.trim();
  const body = lines.slice(firstNonEmpty + 1).join("\n").trim();
  return [{ title, body }];
}

export function bulkCreateTickets(projectId: string, parsed: ParsedTicket[]): Ticket[] {
  const created: Ticket[] = [];
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_key, title, body, status, repos_touched, depends_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbox', '[]', '[]', ?, ?)`,
  );
  for (const t of parsed) {
    const id = nanoid(10);
    const key = allocateTicketKey(projectId);
    stmt.run(id, projectId, key, t.title, t.body, now, now);
    const ticket = loadTicket(id);
    if (ticket) created.push(ticket);
  }
  return created;
}
