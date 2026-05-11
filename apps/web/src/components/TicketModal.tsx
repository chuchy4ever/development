import { useEffect, useMemo, useRef, useState } from "react";
import type { Priority, ProjectWithRepos, Run, Ticket, TicketStatus } from "@ceo/shared";
import { api } from "../api";
import { RunView } from "./RunView";
import { useEscClose } from "../hooks";
import { t, useLang } from "../i18n";
import { renderMarkdown } from "../utils/markdown";
import { formatDurationMs, formatRelativeAge, gitBranchWebUrl, gitRemoteToWebUrl } from "../utils/time";

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
  useEscClose(onClose);
  const parent = ticket.parent_ticket_id
    ? (allTickets ?? []).find((t) => t.id === ticket.parent_ticket_id) ?? null
    : null;
  const children = (allTickets ?? []).filter((tk) => tk.parent_ticket_id === ticket.id);
  useLang();

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
      ? t("tm.confirm.delete_with_runs", { count: runs.length })
      : t("tm.confirm.delete");
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api.deleteTicket(project.id, ticket.id);
      await onChanged();
      onClose();
    } finally { setBusy(false); }
  }

  // Per-ticket aggregations across runs — rolled up once, used in several places.
  const aggregate = useMemo(() => {
    let totalCost = 0;
    let totalWallMs = 0;
    let badCount = 0;
    let brokenInProd = false;
    let lastFinishedAt: string | null = null;
    for (const r of runs) {
      if (typeof r.total_cost_usd === "number") totalCost += r.total_cost_usd;
      if (r.started_at && r.finished_at) {
        totalWallMs += new Date(r.finished_at).getTime() - new Date(r.started_at).getTime();
      }
      if (r.user_verdict === "bad") badCount++;
      if (r.user_verdict === "broken_in_prod") brokenInProd = true;
      if (r.finished_at && (!lastFinishedAt || r.finished_at > lastFinishedAt)) {
        lastFinishedAt = r.finished_at;
      }
    }
    return { totalCost, totalWallMs, badCount, brokenInProd, lastFinishedAt };
  }, [runs]);
  const activeRun = runs.find((r) => r.status === "running" || r.status === "pending" || r.status === "awaiting_approval");
  const lastActivity = activeRun?.started_at ?? aggregate.lastFinishedAt ?? ticket.updated_at;

  /** Concrete reason why the Start run button is disabled — better than a vague
   *  tooltip. Returns null when the button is enabled. */
  const startDisabledReason = (() => {
    if (busy) return t("tm.start_disabled.busy");
    if (project.repos.length === 0) return t("tm.start_disabled.no_repos");
    if (activeRun) return t("tm.start_disabled.active_run", { id: activeRun.id.slice(0, 8) });
    return null;
  })();
  const canStartRun = startDisabledReason === null;

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="ticket-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
              {aggregate.brokenInProd && (
                <span title={t("tm.header.verdict_broken")} style={{
                  padding: "3px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600,
                  background: "rgba(127, 29, 29, 0.12)", color: "#7f1d1d",
                  border: "1px solid rgba(127, 29, 29, 0.3)",
                }}>{t("tm.header.verdict_broken")}</span>
              )}
              {!aggregate.brokenInProd && aggregate.badCount > 0 && (
                <span title={t("tm.header.verdict_bad", { count: aggregate.badCount })} style={{
                  padding: "3px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600,
                  background: "rgba(220, 38, 38, 0.1)", color: "#b91c1c",
                  border: "1px solid rgba(220, 38, 38, 0.3)",
                }}>{t("tm.header.verdict_bad", { count: aggregate.badCount })}</span>
              )}
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

            <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end", fontSize: 11, color: "var(--text-dim)" }}>
              <span title={ticket.updated_at}>{t("tm.header.updated", { ago: formatRelativeAge(lastActivity) })}</span>
              <span title={ticket.created_at}>{t("tm.header.created", { ago: formatRelativeAge(ticket.created_at) })}</span>
            </div>

            <button className="tm-close" onClick={onClose} title={t("tm.close_title")}>✕</button>
          </header>

          <div className="tm-body">
            <main className="tm-main">
              {parent && (
                <Section title={t("tm.section.parent")}>
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

              {/* Active run prominent card — surfaces what's happening NOW
                  instead of burying it in the Runs history list below. */}
              {runs.find((r) => r.status === "running" || r.status === "pending" || r.status === "awaiting_approval") && (() => {
                const active = runs.find((r) => r.status === "running" || r.status === "pending" || r.status === "awaiting_approval")!;
                return (
                  <Section title={t("tm.section.active_run")}>
                    <button
                      className="tm-link-row"
                      onClick={() => setOpenRunId(active.id)}
                      style={{
                        background: "var(--accent-soft, rgba(124,92,255,0.08))",
                        border: "1px solid var(--accent)",
                        padding: "10px 12px",
                      }}
                    >
                      <span style={{ flex: 1, textAlign: "left" }}>
                        <b>{active.current_agent_name ?? t("tm.run.waiting_for_dispatch")}</b>
                        <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: 12 }}>
                          · {active.branch}
                        </span>
                      </span>
                      {typeof active.total_cost_usd === "number" && active.total_cost_usd > 0 && (
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                          {t("tm.run.cost", { cost: active.total_cost_usd.toFixed(2) })}
                        </span>
                      )}
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                        color: runStatusColor(active.status).fg,
                        background: runStatusColor(active.status).bg,
                      }}>{active.status}</span>
                    </button>
                  </Section>
                );
              })()}

              <Section
                title={t("tm.section.description")}
                action={!editingBody && (
                  <button onClick={() => setEditingBody(true)}>{t("tm.btn.edit")}</button>
                )}
              >
                {editingBody ? (
                  <div>
                    <textarea
                      autoFocus
                      value={bodyDraft}
                      onChange={(e) => setBodyDraft(e.target.value)}
                      rows={10}
                      placeholder={t("tm.body.placeholder")}
                    />
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button className="primary" onClick={saveBody} disabled={busy}>{t("common.save")}</button>
                      <button onClick={() => { setEditingBody(false); setBodyDraft(ticket.body); }}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                ) : ticket.body ? (
                  <div
                    className="tm-prose md-body"
                    onClick={() => setEditingBody(true)}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(ticket.body) }}
                  />
                ) : (
                  <div className="tm-prose" onClick={() => setEditingBody(true)}>
                    <span style={{ color: "var(--text-muted)" }}>{t("tm.body.empty")}</span>
                  </div>
                )}
              </Section>

              {ticket.triage_notes && (
                <Section title={t("tm.section.triage_notes")}>
                  <div
                    className="tm-callout md-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(ticket.triage_notes) }}
                  />
                </Section>
              )}

              {children.length > 0 && (() => {
                const doneCount = children.filter((c) => c.status === "done").length;
                const pct = Math.round((doneCount / children.length) * 100);
                return (
                  <Section title={t("tm.section.subtasks", { done: doneCount, total: children.length })}>
                    <div style={{
                      height: 6, borderRadius: 3, background: "var(--gray-soft)",
                      marginBottom: 10, overflow: "hidden",
                    }}>
                      <div style={{
                        width: `${pct}%`, height: "100%",
                        background: pct === 100 ? "var(--green)" : "var(--accent)",
                        transition: "width 200ms",
                      }} />
                    </div>
                    {(["running", "review", "backlog", "blocked", "done", "inbox"] as TicketStatus[]).map((statusGroup) => {
                      const group = children.filter((c) => c.status === statusGroup);
                      if (group.length === 0) return null;
                      return (
                        <div key={statusGroup} style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 4, letterSpacing: 0.3 }}>
                            {t(`tm.subtasks.${statusGroup}`)} ({group.length})
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {group.map((c) => (
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
                                {c.depends_on.length > 0 && (
                                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                                    ⏸ {c.depends_on.length}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </Section>
                );
              })()}
              <Section title={t("tm.history.title")}>
                <HistoryTimeline ticket={ticket} runs={runs} />
              </Section>

              {runs.length > 0 && (
                <Section title={`${t("tm.section.runs", { count: runs.length })} · $${aggregate.totalCost.toFixed(2)} · ${formatDurationMs(aggregate.totalWallMs)}`}>
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
              <SideField label={t("tm.side.status")}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {STATUSES.map((s) => {
                    const active = ticket.status === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => !active && setStatus(s)}
                        disabled={busy}
                        title={s}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: 10,
                          border: `1px solid ${active ? STATUS_FG[s] : "var(--border)"}`,
                          background: active ? STATUS_BG[s] : "transparent",
                          color: active ? STATUS_FG[s] : "var(--text-dim)",
                          cursor: busy || active ? "default" : "pointer",
                          display: "flex", alignItems: "center", gap: 4,
                        }}
                      >
                        <span style={{
                          display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                          background: STATUS_FG[s],
                        }} />
                        {t(`tm.subtasks.${s}`)}
                      </button>
                    );
                  })}
                </div>
              </SideField>

              <SideField label={t("tm.side.priority")}>
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

              <SideField label={t("tm.side.workflow")}>
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {ticket.workflow_template ?? t("tm.side.workflow_unset")}
                </div>
              </SideField>

              <SideField label={t("tm.side.folders")}>
                {project.repos.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("tm.side.folders_empty")}</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {project.repos.map((r) => {
                      const on = ticket.repos_touched.includes(r.name);
                      const branchUrl = gitBranchWebUrl(r.url, r.default_branch);
                      const webUrl = gitRemoteToWebUrl(r.url);
                      const host = webUrl ? webUrl.replace(/^https?:\/\//, "").split("/")[0] : null;
                      return (
                        <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <label className="tm-checkbox">
                            <input type="checkbox" checked={on} onChange={() => toggleRepo(r.name)} disabled={busy} />
                            <span>{r.name}</span>
                          </label>
                          {branchUrl && host && (
                            <a
                              href={branchUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                fontSize: 10, color: "var(--text-dim)",
                                paddingLeft: 22, textDecoration: "none",
                              }}
                              onMouseEnter={(e) => { (e.target as HTMLAnchorElement).style.textDecoration = "underline"; }}
                              onMouseLeave={(e) => { (e.target as HTMLAnchorElement).style.textDecoration = "none"; }}
                            >
                              {t("tm.gitlink.branch", { branch: r.default_branch, host })}
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </SideField>

              {ticket.depends_on.length > 0 && (
                <SideField label={t("tm.side.depends_on", { count: ticket.depends_on.length })}>
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
            <button className="danger" onClick={del} disabled={busy}>{t("common.delete")}</button>
            <div style={{ flex: 1 }} />
            <button onClick={triage} disabled={busy} title={t("tm.btn.triage_title")}>
              {ticket.priority ? t("tm.btn.retriage") : t("tm.btn.triage")}
            </button>
            <button onClick={decompose} disabled={busy} title={t("tm.btn.decompose_title")}>
              {t("tm.btn.decompose")}
            </button>
            <button
              className="primary"
              onClick={startRun}
              disabled={!canStartRun}
              title={startDisabledReason ?? t("tm.btn.start_run")}
            >
              {busy ? "..." : t("tm.btn.start_run")}
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

/** Chronological event list for the ticket: created → triage → runs (started
 *  + finished + verdict) → updated. Helps understand the ticket's life cycle
 *  without piecing it together from disparate sections. */
function HistoryTimeline({ ticket, runs }: { ticket: Ticket; runs: Run[] }) {
  interface Event { at: string; label: string; tone: "neutral" | "ok" | "warn" | "fail"; sub?: string }
  const events: Event[] = [];
  events.push({ at: ticket.created_at, label: t("tm.history.created"), tone: "neutral" });
  if (ticket.triage_notes && ticket.priority) {
    // Triage time isn't stored separately; treat the priority being set as proxy.
    // Use updated_at as best-available timestamp when there are no runs yet.
    if (runs.length === 0 && ticket.updated_at !== ticket.created_at) {
      events.push({ at: ticket.updated_at, label: t("tm.history.triaged"), tone: "neutral", sub: ticket.priority });
    }
  }
  for (const r of runs) {
    if (r.started_at) {
      events.push({
        at: r.started_at,
        label: t("tm.history.run_started", { id: r.id.slice(0, 6) }),
        tone: "neutral",
      });
    }
    if (r.finished_at) {
      const tone: Event["tone"] = r.status === "succeeded" ? "ok" : r.status === "failed" ? "fail" : "warn";
      events.push({
        at: r.finished_at,
        label: t("tm.history.run_finished", { id: r.id.slice(0, 6), status: r.status }),
        tone,
        sub: typeof r.total_cost_usd === "number" ? `$${r.total_cost_usd.toFixed(2)}` : undefined,
      });
    }
    if (r.user_verdict && r.user_verdict_at) {
      events.push({
        at: r.user_verdict_at,
        label: t("tm.history.verdict_set", { verdict: r.user_verdict }),
        tone: r.user_verdict === "good" ? "ok" : "fail",
      });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  if (events.length === 0) return null;
  const toneColor: Record<Event["tone"], string> = {
    neutral: "var(--text-dim)", ok: "var(--green)", warn: "var(--yellow)", fail: "var(--red)",
  };
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}>
      {events.map((e, i) => (
        <li key={i} style={{ display: "grid", gridTemplateColumns: "12px 110px 1fr auto", gap: 8, padding: "3px 0", alignItems: "center" }}>
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: toneColor[e.tone], marginLeft: 2,
          }} />
          <span style={{ color: "var(--text-dim)", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
            {new Date(e.at).toLocaleString()}
          </span>
          <span>{e.label}</span>
          {e.sub && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{e.sub}</span>}
        </li>
      ))}
    </ol>
  );
}
