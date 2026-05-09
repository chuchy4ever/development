import { db, nowIso } from "./db.js";
import { buildTicketKey, computeKeyPrefix } from "./ticketKey.js";

/**
 * For each existing project: ensure key_prefix is set; assign ticket_key to any
 * ticket missing one (in created_at order); store next_ticket_seq.
 * Idempotent — only fills missing values.
 */
export function backfillTicketKeys(): void {
  const projects = db
    .prepare("SELECT id, name, key_prefix FROM projects")
    .all() as { id: string; name: string; key_prefix: string }[];

  for (const p of projects) {
    let prefix = p.key_prefix;
    if (!prefix) {
      prefix = computeKeyPrefix(p.name);
      db.prepare("UPDATE projects SET key_prefix = ?, updated_at = ? WHERE id = ?")
        .run(prefix, nowIso(), p.id);
    }

    const tickets = db
      .prepare(
        "SELECT id, ticket_key FROM tickets WHERE project_id = ? ORDER BY created_at ASC",
      )
      .all(p.id) as { id: string; ticket_key: string | null }[];

    let seq = 1;
    for (const t of tickets) {
      if (!t.ticket_key) {
        db.prepare("UPDATE tickets SET ticket_key = ?, updated_at = ? WHERE id = ?")
          .run(buildTicketKey(prefix, seq), nowIso(), t.id);
      } else {
        // Track the highest seq from existing keys so new tickets continue cleanly.
        const m = t.ticket_key.match(/-(\d+)$/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && n >= seq) seq = n;
        }
      }
      seq++;
    }
    db.prepare("UPDATE projects SET next_ticket_seq = ? WHERE id = ?")
      .run(seq, p.id);
  }
}

/**
 * Atomically allocate the next ticket key for a project and bump the counter.
 */
export function allocateTicketKey(projectId: string): string {
  const tx = db.transaction((pid: string) => {
    const row = db
      .prepare("SELECT key_prefix, next_ticket_seq FROM projects WHERE id = ?")
      .get(pid) as { key_prefix: string; next_ticket_seq: number } | undefined;
    if (!row) throw new Error("project not found");
    const prefix = row.key_prefix || "TKT";
    const seq = row.next_ticket_seq || 1;
    const key = buildTicketKey(prefix, seq);
    db.prepare("UPDATE projects SET next_ticket_seq = ? WHERE id = ?")
      .run(seq + 1, pid);
    return key;
  });
  return tx(projectId);
}
