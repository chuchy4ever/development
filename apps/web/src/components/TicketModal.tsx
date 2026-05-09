import { useEffect, useRef, useState } from "react";
import type { Priority, ProjectWithRepos, Run, Ticket, TicketStatus } from "@ceo/shared";
import { api } from "../api";
import { RunView } from "./RunView";

interface Props {
  ticket: Ticket;
  project: ProjectWithRepos;
  allTickets?: Ticket[];
  onOpenTicket?: (ticket: Ticket) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const STATUSES: TicketStatus[] = ["inbox", "backlog", "running", "review", "done", "blocked"];
const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

const STATUS_BG: Record<TicketStatus, string> = {
  inbox: "var(--gray-soft)",
  backlog: "var(--accent-soft)",
  running: "var(--blue-soft)",
  review: "var(--yellow-soft)",
  done: "var(--green-soft)",
  blocked: "var(--red-soft)",
};
const STATUS_FG: Record<TicketStatus, string> = {
  inbox: "#475569",
  backlog: "var(--accent-strong)",
  running: "#1d4ed8",
  review: "#b45309",
  done: "#047857",
  blocked: "#b91c1c",
};

export function TicketModal({ ticket, project, allTickets, onOpenTicket, onClose, onChanged }: Props) {
  const parent = ticket.parent_ticket_id
    ? (allTickets ?? []).find((t) => t.id === ticket.parent_ticket_id) ?? null
    : null;
  const children = (allTickets ?? []).filter((t) => t.parent_ticket_id === ticket.id);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(ticket.title);
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(ticket.body);

  useEffect(() => {
    setTitleDraft(ticket.title);
    setBodyDraft(ticket.body);
  }, [ticket.id, ticket.title, ticket.body]);

  async function refreshRuns() {
    const list = await api.listTicketRuns(ticket.id);
    setRuns(list);
  }
  useEffect(() => { refreshRuns().catch(console.error); }, [ticket.id]);

  async function patch(body: Partial<Ticket>) {
    setBusy(true);
    setErr(null);
    try {
      await api.updateTicket(project.id, ticket.id, body);
      await onChanged();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    if (!titleDraft.trim() || titleDraft === ticket.title) {
      setEditingTitle(false);
      setTitleDraft(ticket.title);
      return;
    }
    await patch({ title: titleDraft.trim() });
    setEditingTitle(false);
  }

  async function saveBody() {
    if (bodyDraft === ticket.body) {
      setEditingBody(false);
      return;
    }
    await patch({ body: bodyDraft });
    setEditingBody(false);
  }

  async function setStatus(s: TicketStatus) { await patch({ status: s }); }
  async function setPriority(p: Priority | null) { await patch({ priority: p ?? null as any }); }
  async function toggleRepo(name: string) {
    const set = new Set(ticket.repos_touched);
    if (set.has(name)) set.delete(name); else set.add(name);
    await patch({ repos_touched: [...set] });
  }

  async function triage() {
    setBusy(true); setErr(null); setActionMsg(null);
    try {
      await api.triageTicket(project.id, ticket.id);
      await onChanged();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function decompose() {
    if (!confirm("Run CTO to decompose this ticket into subtasks? This will create child tickets and mark this one as 'blocked'.")) return;
    setBusy(true); setErr(null); setActionMsg(null);
    try {
      const r = await api.decomposeTicket(project.id, ticket.id);
      await onChanged();
      setActionMsg(r.decomposed
        ? `CTO created ${r.created.length} subtask(s). ${r.rationale}`
        : `CTO chose not to decompose. ${r.rationale}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function startRun() {
    setBusy(true); setErr(null); setActionMsg(null);
    try {
      const run = await api.startRun(project.id, ticket.id);
      await refreshRuns();
      await onChanged();
      setOpenRunId(run.id);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function del() {
    const msg = runs.length > 0
      ? `Delete this ticket? ${runs.length} run(s) and their worktrees will be removed.`
      : "Delete this ticket?";
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api.deleteTicket(project.id, ticket.id);
      await onChanged();
      onClose();
    } finally { setBusy(false); }
  }

  const canStartRun = project.repos.length > 0 && ticket.status !== "running";

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="ticket-modal" onClick={(e) => e.stopPropagation()}>
          <header className="tm-header">
            <div className="tm-key-block">
              {ticket.ticket_key && <div className="tm-key">{ticket.ticket_key}</div>}
              <div className="tm-status" style={{
                background: STATUS_BG[ticket.status],
                color: STATUS_FG[ticket.status],
              }}>
                <span className="tm-status-dot" style={{ background: STATUS_FG[ticket.status] }} />
                {ticket.status}
              </div>
            </div>

            {editingTitle ? (
              <TitleEditor
                draft={titleDraft}
                setDraft={setTitleDraft}
                onSave={saveTitle}
                onCancel={() => { setEditingTitle(false); setTitleDraft(ticket.title); }}
              />
            ) : (
              <h2 className="tm-title" onClick={() => setEditingTitle(true)} title="Click to edit">
                {ticket.title}
              </h2>
            )}

            <button className="tm-close" onClick={onClose} title="Close (Esc)">✕</button>
          </header>

          <div className="tm-body">
            <main className="tm-main">
              {parent && (
                <Section title="Parent">
                  <button
                    className="tm-link-row"
                    onClick={() => onOpenTicket?.(parent)}
                  >
                    ↳ {parent.ticket_key && <span className="ticket-key">{parent.ticket_key}</span>}
                    <span style={{ flex: 1, textAlign: "left" }}>{parent.title}</span>
                    <StatusPill status={parent.status} />
                  </button>
                </Section>
              )}

              <Section
                title="Description"
                action={!editingBody && (
                  <button onClick={() => setEditingBody(true)}>Edit</button>
                )}
              >
                {editingBody ? (
                  <div>
                    <textarea
                      autoFocus
                      value={bodyDraft}
                      onChange={(e) => setBodyDraft(e.target.value)}
                      rows={10}
                      placeholder="(empty)"
                    />
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button className="primary" onClick={saveBody} disabled={busy}>Save</button>
                      <button onClick={() => { setEditingBody(false); setBodyDraft(ticket.body); }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="tm-prose" onClick={() => setEditingBody(true)}>
                    {ticket.body || <span style={{ color: "var(--text-muted)" }}>(empty — click to add)</span>}
                  </div>
                )}
              </Section>

              {ticket.triage_notes && (
                <Section title="Triage notes">
                  <div className="tm-callout">{ticket.triage_notes}</div>
                </Section>
              )}

              {children.length > 0 && (
                <Section title={`Subtasks (${children.filter((c) => c.status === "done").length}/${children.length} done)`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {children.map((c) => (
                      <button
                        key={c.id}
                        className="tm-link-row"
                        onClick={() => onOpenTicket?.(c)}
                      >
                        {c.ticket_key && <span className="ticket-key">{c.ticket_key}</span>}
                        {c.priority && (
                          <span className={`priority-badge priority-${c.priority}`}>{c.priority}</span>
                        )}
                        <span style={{ flex: 1, textAlign: "left" }}>{c.title}</span>
                        <StatusPill status={c.status} />
                        {c.depends_on.length > 0 && (
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                            ⏸ {c.depends_on.length}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </Section>
              )}

              {runs.length > 0 && (
                <Section title="Runs">
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {runs.map((r) => (
                      <button
                        key={r.id}
                        className="tm-link-row"
                        onClick={() => setOpenRunId(r.id)}
                      >
                        <code style={{ fontSize: 11, padding: 0, background: "transparent" }}>
                          {r.id.slice(0, 8)}
                        </code>
                        <span style={{ flex: 1, textAlign: "left", color: "var(--text-dim)", fontSize: 12 }}>
                          {r.current_agent_name ?? r.agent_role}
                          <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>· {r.branch}</span>
                        </span>
                        {typeof r.total_cost_usd === "number" && (
                          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                            ${r.total_cost_usd.toFixed(4)}
                          </span>
                        )}
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 7px",
                          borderRadius: 4,
                          color: runStatusColor(r.status).fg,
                          background: runStatusColor(r.status).bg,
                        }}>{r.status}</span>
                      </button>
                    ))}
                  </div>
                </Section>
              )}
            </main>

            <aside className="tm-side">
              <SideField label="Status">
                <select value={ticket.status} onChange={(e) => setStatus(e.target.value as TicketStatus)} disabled={busy}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </SideField>

              <SideField label="Priority">
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {PRIORITIES.map((p) => (
                    <button
                      key={p}
                      className={`priority-toggle ${ticket.priority === p ? "active" : ""}`}
                      style={{
                        ["--pcolor" as any]: `var(--p${p[1]})`,
                      }}
                      onClick={() => setPriority(ticket.priority === p ? null : p)}
                      disabled={busy}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </SideField>

              <SideField label="Workflow">
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {ticket.workflow_template ?? "(set by Triage)"}
                </div>
              </SideField>

              <SideField label="Folders">
                {project.repos.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>(no folders in project)</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {project.repos.map((r) => {
                      const on = ticket.repos_touched.includes(r.name);
                      return (
                        <label key={r.id} className="tm-checkbox">
                          <input type="checkbox" checked={on} onChange={() => toggleRepo(r.name)} disabled={busy} />
                          <span>{r.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </SideField>

              {ticket.depends_on.length > 0 && (
                <SideField label={`Depends on (${ticket.depends_on.length})`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {ticket.depends_on.map((dep) => {
                      const t = (allTickets ?? []).find((x) => x.id === dep);
                      return (
                        <button
                          key={dep}
                          className="tm-link-row"
                          onClick={() => t && onOpenTicket?.(t)}
                          style={{ padding: "6px 8px", fontSize: 12 }}
                        >
                          {t?.ticket_key && <span className="ticket-key">{t.ticket_key}</span>}
                          <span style={{ flex: 1, textAlign: "left" }}>{t?.title ?? dep}</span>
                          {t && <StatusPill status={t.status} />}
                        </button>
                      );
                    })}
                  </div>
                </SideField>
              )}
            </aside>
          </div>

          {(actionMsg || err) && (
            <div className="tm-banner" style={err ? { background: "var(--red-soft)", color: "#b91c1c" } : {}}>
              {err ?? actionMsg}
            </div>
          )}

          <footer className="tm-footer">
            <button className="danger" onClick={del} disabled={busy}>Delete</button>
            <div style={{ flex: 1 }} />
            <button onClick={triage} disabled={busy} title="Run Triage agent">
              {ticket.priority ? "Re-triage" : "Triage"}
            </button>
            <button onClick={decompose} disabled={busy} title="Run CTO to split into subtasks">
              Decompose
            </button>
            <button
              className="primary"
              onClick={startRun}
              disabled={busy || !canStartRun}
              title={!canStartRun ? "Add a folder or wait for current run" : "Start workflow run"}
            >
              {busy ? "..." : "▶ Start run"}
            </button>
          </footer>
        </div>
      </div>
      {openRunId && (
        <RunView runId={openRunId} onClose={() => {
          setOpenRunId(null);
          refreshRuns();
          onChanged();
        }} />
      )}
    </>
  );
}

function TitleEditor({ draft, setDraft, onSave, onCancel }: {
  draft: string;
  setDraft: (s: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  return (
    <input
      ref={inputRef}
      className="tm-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={onSave}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSave();
        else if (e.key === "Escape") onCancel();
      }}
    />
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="tm-section">
      <div className="tm-section-head">
        <h3>{title}</h3>
        <div>{action}</div>
      </div>
      {children}
    </section>
  );
}

function SideField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tm-side-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: TicketStatus }) {
  return (
    <span className="tm-status-mini" style={{ background: STATUS_BG[status], color: STATUS_FG[status] }}>
      {status}
    </span>
  );
}

function runStatusColor(s: Run["status"]): { fg: string; bg: string } {
  switch (s) {
    case "succeeded": return { fg: "#047857", bg: "var(--green-soft)" };
    case "failed":    return { fg: "#b91c1c", bg: "var(--red-soft)" };
    case "running":   return { fg: "#1d4ed8", bg: "var(--blue-soft)" };
    case "cancelled": return { fg: "#475569", bg: "var(--gray-soft)" };
    default:          return { fg: "#475569", bg: "var(--gray-soft)" };
  }
}
