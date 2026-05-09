import type { ActiveRunSummary, Ticket, TicketStatus } from "@ceo/shared";

interface Props {
  tickets: Ticket[];
  activeRuns?: ActiveRunSummary[];
  onCardClick: (ticket: Ticket) => void;
}

const COLUMNS: { id: TicketStatus; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "backlog", label: "Backlog" },
  { id: "running", label: "Running" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked" },
];

const STATUS_COLOR: Record<TicketStatus, string> = {
  inbox: "var(--text-dim)",
  backlog: "#7c5cff",
  running: "var(--accent)",
  review: "var(--yellow)",
  done: "var(--green)",
  blocked: "var(--red)",
};

export function Kanban({ tickets, activeRuns, onCardClick }: Props) {
  const activeByTicket = new Map<string, ActiveRunSummary>();
  for (const r of activeRuns ?? []) activeByTicket.set(r.ticket_id, r);
  const byStatus: Record<TicketStatus, Ticket[]> = {
    inbox: [], backlog: [], running: [], review: [], done: [], blocked: [],
  };
  for (const t of tickets) byStatus[t.status].push(t);

  // Cross-column relationships, computed once.
  const titleById = new Map<string, string>();
  const childrenByParent = new Map<string, Ticket[]>();
  for (const t of tickets) {
    titleById.set(t.id, t.title);
    if (t.parent_ticket_id) {
      const list = childrenByParent.get(t.parent_ticket_id) ?? [];
      list.push(t);
      childrenByParent.set(t.parent_ticket_id, list);
    }
  }

  return (
    <div className="kanban">
      {COLUMNS.map((col) => (
        <div key={col.id} className="column">
          <div className="column-header">
            <span>{col.label}</span>
            <span>{byStatus[col.id].length}</span>
          </div>
          <div className="column-body">
            {byStatus[col.id].map((t) => (
              <TicketCard
                key={t.id}
                ticket={t}
                parentTitle={t.parent_ticket_id ? titleById.get(t.parent_ticket_id) ?? null : null}
                children={childrenByParent.get(t.id) ?? null}
                activeRun={activeByTicket.get(t.id) ?? null}
                onClick={() => onCardClick(t)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface CardProps {
  ticket: Ticket;
  parentTitle: string | null;
  children: Ticket[] | null;
  activeRun: ActiveRunSummary | null;
  onClick: () => void;
}

const ROLE_COLOR_HEX: Record<string, string> = {
  coder: "#6d4dff",
  reviewer: "#f59e0b",
  tester: "#10b981",
};

function TicketCard({ ticket, parentTitle, children, activeRun, onClick }: CardProps) {
  const isSubtask = !!ticket.parent_ticket_id;
  const hasChildren = !!children && children.length > 0;
  return (
    <div
      className={`card ${isSubtask ? "card-subtask" : ""}`}
      onClick={onClick}
    >
      {parentTitle && (
        <div className="card-parent" title={`Subtask of: ${parentTitle}`}>
          ↳ {parentTitle.length > 36 ? parentTitle.slice(0, 36) + "…" : parentTitle}
        </div>
      )}
      <div className="card-title">
        {ticket.ticket_key && (
          <span className="ticket-key">{ticket.ticket_key}</span>
        )}
        {ticket.title}
      </div>
      <div className="card-meta">
        {ticket.priority && (
          <span className={`priority-badge priority-${ticket.priority}`}>
            {ticket.priority}
          </span>
        )}
        {ticket.workflow_template && <span>{ticket.workflow_template}</span>}
        {ticket.repos_touched.length > 0 && (
          <span>{ticket.repos_touched.join(", ")}</span>
        )}
      </div>
      {activeRun && (
        <div className="active-worker">
          <span
            className="active-worker-dot"
            style={{ background: ROLE_COLOR_HEX[activeRun.agent_role] ?? "var(--accent)" }}
          />
          <span className="active-worker-name">
            {activeRun.current_agent_name ?? activeRun.agent_role}
          </span>
          <span className="active-worker-role">{activeRun.agent_role}</span>
        </div>
      )}
      {hasChildren && <SubtaskProgress children={children!} />}
      {ticket.depends_on.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
          waiting on {ticket.depends_on.length} ticket{ticket.depends_on.length === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

function SubtaskProgress({ children }: { children: Ticket[] }) {
  const total = children.length;
  const counts: Record<TicketStatus, number> = {
    inbox: 0, backlog: 0, running: 0, review: 0, done: 0, blocked: 0,
  };
  for (const c of children) counts[c.status]++;

  // Show as a row of small dots, one per child, color = status.
  const dots = children.slice(0, 12).map((c, i) => (
    <span
      key={c.id + i}
      title={`${c.title} — ${c.status}`}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATUS_COLOR[c.status],
        marginRight: 3,
      }}
    />
  ));

  return (
    <div style={{
      marginTop: 8,
      paddingTop: 8,
      borderTop: "1px dashed var(--border)",
      fontSize: 11,
      color: "var(--text-dim)",
      display: "flex",
      alignItems: "center",
      gap: 8,
    }}>
      <span>{counts.done}/{total} subtasks</span>
      <div>
        {dots}
        {children.length > 12 && <span>…</span>}
      </div>
    </div>
  );
}
