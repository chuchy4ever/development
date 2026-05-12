import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Run } from "@ceo/shared";
import { api, streamRunEvents } from "../api";
import { t, useLang } from "../i18n";
import { useEscClose } from "../hooks";

interface Props {
  runId: string;
  onClose: () => void;
}

interface UiEvent {
  id: number;
  ts: string;
  type: string;
  payload: any;
}

/** Event filter buckets — broad categories the user can show/hide. */
type FilterKey = "director" | "tools" | "phases" | "system" | "errors" | "diffs";

function filterLabel(k: FilterKey): string {
  const icon = { director: "🎬", tools: "🔧", phases: "▶", system: "ℹ", errors: "❗", diffs: "📝" }[k];
  return `${icon} ${t(`filter.${k}`)}`;
}

function classifyEvent(type: string): FilterKey | null {
  if (type.startsWith("director_")) return "director";
  if (type === "claude_stream") return "tools";
  if (type === "phase_start" || type === "phase_end" || type === "command_start" || type === "command_output" || type === "command_end" || type === "awaiting_approval") return "phases";
  if (type === "stderr") return "errors";
  if (type === "diff") return "diffs";
  if (type === "system" || type === "stdout" || type === "done") return "system";
  return null;
}

export function RunView({ runId, onClose }: Props) {
  useEscClose(onClose);
  useLang();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<UiEvent[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "director" | "log" | "diff">("overview");
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    api.getRun(runId).then((r) => {
      if (active) setRun(r);
    });

    // Batch incoming events: SSE can fire dozens per second during a busy run.
    // Without batching that's one re-render per event.
    //
    // Cap: a long run can emit thousands of claude_stream events. Unbounded
    // accumulation slows re-renders and bloats memory. We keep the most recent
    // EVENT_CAP events; older ones are dropped (they can still be retrieved
    // via the Export Log button, which fetches from the server).
    const EVENT_CAP = 5000;
    const queue: UiEvent[] = [];
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (queue.length === 0) return;
      const batch = queue.splice(0, queue.length);
      setEvents((prev) => {
        // Dedup by event id over the full prev + batch — independent of any
        // closure-local Set so it survives React StrictMode double-mount,
        // EventSource auto-reconnect (which replays from since=0 each time),
        // or any other path that could resend already-seen events.
        const seen = new Set<number>();
        const out: UiEvent[] = [];
        for (const e of prev) {
          if (typeof e.id !== "number" || seen.has(e.id)) continue;
          seen.add(e.id);
          out.push(e);
        }
        for (const e of batch) {
          if (typeof e.id !== "number" || seen.has(e.id)) continue;
          seen.add(e.id);
          out.push(e);
        }
        // Cap memory on very long runs — keep the most recent EVENT_CAP events.
        return out.length <= EVENT_CAP ? out : out.slice(-EVENT_CAP);
      });
    };

    const stop = streamRunEvents(runId, (ev) => {
      queue.push(ev);
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flush, 80);
      }
      if (ev.type === "done" || ev.type === "phase_end") {
        api.getRun(runId).then((r) => active && setRun(r));
      }
    });
    return () => {
      active = false;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      stop();
    };
  }, [runId]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  // Diffs: the engine emits one per repo per phase_end and re-emits the full
  // set on each restart (tsx watch reload). Dedupe to latest-per-repo so the
  // tab count + view both show the actual final state, not N stale snapshots.
  const diffs = useMemo(() => {
    const all = events.filter((e) => e.type === "diff");
    const latest = new Map<string, UiEvent>();
    for (const d of all) {
      const repo = String(d.payload?.repo_name ?? "");
      if (!repo) continue;
      const prev = latest.get(repo);
      if (!prev || new Date(d.ts).getTime() > new Date(prev.ts).getTime()) {
        latest.set(repo, d);
      }
    }
    return [...latest.values()].sort((a, b) =>
      String(a.payload?.repo_name ?? "").localeCompare(String(b.payload?.repo_name ?? "")),
    );
  }, [events]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  /** Clicking a TeamFlowHeader pill filters LogView to only events from that
   *  Director turn. Null = no filter. */
  const [selectedIter, setSelectedIter] = useState<number | null>(null);

  async function handleCancel() {
    if (!confirm(t("run.confirm_cancel"))) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const r = await api.cancelRun(runId);
      setRun(r);
    } catch (e: any) {
      setActionMsg(`${t("run.cancel_failed")}: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleOpenPr() {
    setActionBusy(true);
    setActionMsg(null);
    try {
      const results = await api.openPr(runId);
      const lines = results.map((r) =>
        r.pr_url
          ? `${r.repo_name}: ${r.pr_url}`
          : `${r.repo_name}: ${r.error ?? "no PR URL"}`,
      );
      setActionMsg(lines.join("\n"));
    } catch (e: any) {
      setActionMsg(`${t("run.openpr_failed")}: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  const isRunning = run?.status === "running" || run?.status === "pending";
  const isAwaitingApproval = run?.status === "awaiting_approval";
  const canPr = run?.status === "succeeded";

  // Most recent awaiting_approval event (so we can show the message even after
  // events list grows long). Iterate from the end without cloning.
  const lastApprovalEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "awaiting_approval") return events[i];
    }
    return undefined;
  }, [events]);
  const approvalMessage = (lastApprovalEvent?.payload as any)?.message as string | null | undefined;
  const approvalPhaseId = (lastApprovalEvent?.payload as any)?.phase_id as string | undefined;
  const [approvalNote, setApprovalNote] = useState("");

  async function handleApprove() {
    setActionBusy(true);
    setActionMsg(null);
    try {
      const r = await api.approveRun(runId, approvalNote || undefined);
      setRun(r);
      setApprovalNote("");
    } catch (e: any) {
      setActionMsg(`${t("run.approve_failed")}: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleReject() {
    if (!confirm(t("run.confirm_reject"))) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const r = await api.rejectRun(runId, approvalNote || undefined);
      setRun(r);
      setApprovalNote("");
    } catch (e: any) {
      setActionMsg(`${t("run.reject_failed")}: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSetVerdict(verdict: import("@ceo/shared").RunUserVerdict | null) {
    setActionBusy(true);
    setActionMsg(null);
    try {
      let note: string | null = null;
      if (verdict === "bad" || verdict === "broken_in_prod") {
        note = prompt(verdict === "broken_in_prod" ? t("verdict.prompt_broken") : t("verdict.prompt_bad")) ?? "";
        if (note === null) { setActionBusy(false); return; }
      }
      const r = await api.setRunVerdict(runId, verdict, note ?? undefined);
      setRun(r);
    } catch (e: any) {
      setActionMsg(`${t("verdict.failed")}: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal" role="dialog" aria-modal="true"
        style={{ width: "min(1100px, 95vw)", height: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>{t("run.title", { id: runId.slice(0, 8) })}</h3>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
              {run ? (
                <>
                  <span style={{ marginRight: 12 }}>{t("common.status")}: <b>{run.status}</b></span>
                  <span style={{ marginRight: 12 }}>{t("common.branch")}: <code>{run.branch}</code></span>
                  {run.exit_code != null && <span style={{ marginRight: 12 }}>{t("common.exit")}: {run.exit_code}</span>}
                  {typeof run.total_cost_usd === "number" && (
                    <span style={{ marginRight: 12 }}>
                      {t("common.cost")}: <b style={{ color: "var(--yellow)" }}>${run.total_cost_usd.toFixed(4)}</b>
                    </span>
                  )}
                </>
              ) : t("common.loading")}
            </div>
            {run?.error && (
              <div style={{
                marginTop: 8,
                padding: "6px 10px",
                background: "var(--red-soft)",
                color: "#b91c1c",
                border: "1px solid #fecaca",
                borderRadius: 6,
                fontSize: 12,
                maxWidth: 700,
              }}>
                <b>{t("run.failure_reason")}</b> {run.error}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {isRunning && (
              <button className="danger" onClick={handleCancel} disabled={actionBusy}>
                {t("btn.cancel_run")}
              </button>
            )}
            {canPr && (
              <button className="primary" onClick={handleOpenPr} disabled={actionBusy}>
                {actionBusy ? "..." : t("btn.open_pr")}
              </button>
            )}
            <button onClick={onClose}>{t("common.close")}</button>
          </div>
        </div>
        {actionMsg && (
          <pre style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 10,
            marginTop: 10,
            marginBottom: 0,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            color: "var(--text-dim)",
          }}>{actionMsg}</pre>
        )}

        {isAwaitingApproval && (
          <div style={{
            marginTop: 12,
            border: "1px solid #f59e0b",
            background: "rgba(245, 158, 11, 0.08)",
            borderRadius: 8,
            padding: 14,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 18 }}>⏸</span>
              <b>{t("run.awaiting_approval")}</b>
              {approvalPhaseId && (
                <code style={{ fontSize: 11, color: "var(--text-dim)" }}>phase: {approvalPhaseId}</code>
              )}
            </div>
            {approvalMessage && (
              <div style={{
                fontSize: 13,
                whiteSpace: "pre-wrap",
                marginBottom: 10,
                padding: 8,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}>
                {approvalMessage}
              </div>
            )}
            <input
              value={approvalNote}
              onChange={(e) => setApprovalNote(e.target.value)}
              placeholder={t("run.approval_note_placeholder")}
              style={{ width: "100%", marginBottom: 8, fontSize: 12 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" onClick={handleApprove} disabled={actionBusy}>
                {actionBusy ? "..." : `✓ ${t("btn.approve")}`}
              </button>
              <button className="danger" onClick={handleReject} disabled={actionBusy}>
                ✗ {t("btn.reject")}
              </button>
            </div>
          </div>
        )}

        {run && (run.status === "succeeded" || run.status === "failed") && (
          <VerdictBar run={run} busy={actionBusy} onSet={handleSetVerdict} />
        )}

        {(() => {
          // Pre-filter events per tab so each tab is a focused view instead of
          // hiding 6 chip filters behind one mega log. Director tab = the
          // narrative (decisions, dispatches, what each turn did). Log tab =
          // everything else (tools, phases, system messages, errors) for
          // debugging. Diff tab = code changes.
          const directorEvents = events.filter((e) => classifyEvent(e.type) === "director");
          const restEvents = events.filter((e) => {
            const k = classifyEvent(e.type);
            return k !== null && k !== "director" && k !== "diffs";
          });
          return (
            <>
              <div className="tabs" role="tablist" style={{ marginTop: 12, paddingLeft: 0 }}>
                <button
                  role="tab"
                  aria-selected={activeTab === "overview"}
                  className={`tab tab-button ${activeTab === "overview" ? "active" : ""}`}
                  onClick={() => setActiveTab("overview")}
                >
                  {t("run.tab.overview")}
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "director"}
                  className={`tab tab-button ${activeTab === "director" ? "active" : ""}`}
                  onClick={() => setActiveTab("director")}
                >
                  {t("run.tab.director", { count: directorEvents.length })}
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "log"}
                  className={`tab tab-button ${activeTab === "log" ? "active" : ""}`}
                  onClick={() => setActiveTab("log")}
                >
                  {t("run.tab.log", { count: restEvents.length })}
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "diff"}
                  className={`tab tab-button ${activeTab === "diff" ? "active" : ""}`}
                  onClick={() => setActiveTab("diff")}
                >
                  {t("run.diff", { count: diffs.length })}
                </button>
                <div style={{ flex: 1 }} />
                {(activeTab === "director" || activeTab === "log" || activeTab === "overview") && events.length > 0 && (
                  <button
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `run-${runId}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    title={t("run.export_log_title")}
                    style={{ marginRight: 8, alignSelf: "center", fontSize: 11 }}
                  >
                    ⬇ {t("btn.export_log")}
                  </button>
                )}
              </div>

              <div style={{ flex: 1, overflow: "auto", padding: "12px 0", minHeight: 0 }}>
                {activeTab === "overview" && events.length > 0 && (
                  <>
                    <TeamFlowHeader
                      events={events}
                      selectedIter={selectedIter}
                      onSelectIter={(it) => setSelectedIter((cur) => (cur === it ? null : it))}
                    />
                    <AgentBreakdown events={events} />
                  </>
                )}
                {activeTab === "overview" && events.length === 0 && (
                  <div style={{ color: "var(--text-dim)", padding: 16, fontSize: 12 }}>
                    {t("run.tab.overview_empty")}
                  </div>
                )}
                {activeTab === "director" && (
                  <LogView
                    events={directorEvents}
                    selectedIter={selectedIter}
                    onClearIter={() => setSelectedIter(null)}
                    hiddenFilters={["director", "tools", "phases", "system", "errors", "diffs"]}
                  />
                )}
                {activeTab === "log" && (
                  <LogView
                    events={restEvents}
                    selectedIter={selectedIter}
                    onClearIter={() => setSelectedIter(null)}
                    hiddenFilters={["director", "diffs"]}
                  />
                )}
                {activeTab === "diff" && <DiffView diffs={diffs} />}
                <div ref={logEnd} />
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}

function LogView({
  events,
  selectedIter,
  onClearIter,
  hiddenFilters = [],
}: {
  events: UiEvent[];
  selectedIter: number | null;
  onClearIter: () => void;
  /** Filter chip keys to hide entirely. Each parent tab pre-filters its events
   *  so the chips for those categories aren't relevant here. */
  hiddenFilters?: FilterKey[];
}) {
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    director: true,
    tools: false,    // claude_stream is noisy by default — but enabled when this is the only "tools" view
    phases: true,
    system: true,
    errors: true,
    diffs: true,
  });
  const hidden = new Set(hiddenFilters);
  // Pre-compute iteration boundaries: each director_decision starts a turn,
  // events between this decision (inclusive) and the next director_decision
  // (exclusive) belong to that turn. The very first events (before any
  // director_decision — run setup) belong to "turn 0".
  const iterByIndex = useMemo(() => {
    const map: number[] = new Array(events.length);
    let current = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.type === "director_decision") {
        const it = (e.payload as { iteration?: number } | undefined)?.iteration;
        if (typeof it === "number") current = it;
      }
      map[i] = current;
    }
    return map;
  }, [events]);
  // Count by category for chip badges — narrowed to selected iteration if any.
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { director: 0, tools: 0, phases: 0, system: 0, errors: 0, diffs: 0 };
    for (let i = 0; i < events.length; i++) {
      if (selectedIter !== null && iterByIndex[i] !== selectedIter) continue;
      const k = classifyEvent(events[i]!.type);
      if (k) c[k]++;
    }
    return c;
  }, [events, iterByIndex, selectedIter]);
  const filtered = useMemo(
    () => events.filter((e, i) => {
      if (selectedIter !== null && iterByIndex[i] !== selectedIter) return false;
      const k = classifyEvent(e.type);
      return k ? filters[k] : true;
    }),
    [events, iterByIndex, selectedIter, filters],
  );
  const visibleFilterKeys = (["director","tools","phases","system","errors","diffs"] as FilterKey[]).filter((k) => !hidden.has(k));
  // Only show the sticky filter strip when there's actually something in it:
  // visible filter chips OR an active iteration filter. Empty strip rendered
  // an awkward whitespace band above the log content.
  const showFilterStrip = visibleFilterKeys.length > 0 || selectedIter !== null;
  return (
    <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}>
      {showFilterStrip && (
      <div style={{
        position: "sticky", top: 0, zIndex: 5,
        display: "flex", flexWrap: "wrap", gap: 6,
        padding: "6px 0 8px",
        background: "var(--bg)",
        borderBottom: "1px solid var(--border)",
        marginBottom: 6,
      }}>
        {selectedIter !== null && (
          <button
            type="button"
            onClick={onClearIter}
            title="Zrušit filtr na turn"
            style={{
              fontSize: 11, padding: "3px 10px", borderRadius: 12,
              background: "var(--accent)", color: "#fff",
              border: "1px solid var(--accent)",
              fontWeight: 600,
            }}
          >
            ✕ T{selectedIter}
          </button>
        )}
        {visibleFilterKeys.map((k) => (
          <button
            key={k}
            onClick={() => setFilters((f) => ({ ...f, [k]: !f[k] }))}
            style={{
              fontSize: 11, padding: "3px 10px", borderRadius: 12,
              background: filters[k] ? "var(--accent)" : "var(--bg-elev)",
              color: filters[k] ? "#fff" : "var(--text)",
              border: `1px solid ${filters[k] ? "var(--accent)" : "var(--border)"}`,
              opacity: counts[k] === 0 ? 0.45 : 1,
            }}
            disabled={counts[k] === 0}
          >
            {filterLabel(k)} <span style={{ opacity: 0.7 }}>· {counts[k]}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {visibleFilterKeys.length > 0 && (
          <button
            onClick={() => setFilters({ director: true, tools: true, phases: true, system: true, errors: true, diffs: true })}
            style={{ fontSize: 11 }}
          >{t("common.show_all")}</button>
        )}
      </div>
      )}
      {filtered.length === 0 && (
        <div style={{ color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
          {t("run.no_match")}
        </div>
      )}
      {filtered.map((ev) => (
        <EventRow key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

/**
 * AgentBreakdown — aggregates director_dispatch + director_subagent_done
 * events into per-agent stats: dispatches, total cost, total wall time,
 * ok/fail counts, commits added. Shows bounces (>1 dispatch) prominently —
 * those are usually the interesting "where did we get stuck" signal.
 */
type AgentStat = {
  name: string;
  role: string;
  model: string | null;
  dispatches: number;
  cost_usd: number;
  duration_ms: number;
  ok: number;
  fail: number;
  null_count: number;
  commits: number;
};

/** Display name for sub-agents in the breakdown. Most are real agent names
 *  ("PHP Senior Coder") and pass through. Built-in gates like ci_gate and
 *  task-routed phases (task:git_push) get a friendlier label. */
function prettifyAgentName(raw: string): string {
  if (raw === "ci_gate") return "CI gate";
  if (raw === "parallel") return "Parallel batch";
  if (raw.startsWith("task:")) {
    const id = raw.slice("task:".length);
    if (id === "git_push") return "Git push";
    return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (raw.startsWith("fetch_context:")) {
    return `Fetch context (${raw.slice("fetch_context:".length)})`;
  }
  return raw;
}

function AgentBreakdown({ events }: { events: UiEvent[] }) {
  const { stats, totalCost } = useMemo(() => {
    type S = AgentStat & { pending: { startedAt: number } | null };
    const byAgent = new Map<string, S>();
    for (const e of events) {
      const p = e.payload || {};
      const ts = new Date(e.ts).getTime();
      if (e.type === "director_dispatch") {
        const name = String(p.subagent ?? "?");
        let s = byAgent.get(name);
        if (!s) {
          s = { name, role: p.role ?? "", model: p.model ?? null, dispatches: 0, cost_usd: 0, duration_ms: 0, ok: 0, fail: 0, null_count: 0, commits: 0, pending: null };
          byAgent.set(name, s);
        }
        s.dispatches++;
        s.pending = { startedAt: ts };
      } else if (e.type === "director_subagent_done") {
        const name = String(p.subagent ?? "?");
        const s = byAgent.get(name);
        if (!s) continue;
        if (p.ok === true) s.ok++;
        else if (p.ok === false) s.fail++;
        else s.null_count++;
        if (typeof p.cost_usd === "number") s.cost_usd += p.cost_usd;
        if (typeof p.commits_added === "number") s.commits += p.commits_added;
        if (s.pending) s.duration_ms += ts - s.pending.startedAt;
        s.pending = null;
      }
    }
    const stats = Array.from(byAgent.values()).sort((a, b) => b.cost_usd - a.cost_usd);
    const totalCost = stats.reduce((sum, s) => sum + s.cost_usd, 0);
    return { stats, totalCost };
  }, [events]);
  if (stats.length === 0) return null;

  return (
    <div style={{
      marginTop: 10, padding: 12,
      border: "1px solid var(--border)", borderRadius: 8,
      background: "var(--bg-elev)",
    }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {t("run.agent_breakdown", { count: stats.length, total: totalCost.toFixed(2) })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {stats.map((s) => {
          const share = totalCost > 0 ? (s.cost_usd / totalCost) : 0;
          const okFail = s.ok + s.fail;
          const bounce = s.dispatches > 1;
          return (
            <div key={s.name} style={{
              display: "grid",
              gridTemplateColumns: "1.5fr 60px 80px 70px 80px 80px",
              gap: 8,
              alignItems: "center",
              fontSize: 12,
              padding: "4px 6px",
              borderRadius: 4,
              background: bounce ? "rgba(245, 158, 11, 0.07)" : "transparent",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                  background: s.role === "coder" ? "var(--cat-coding)" : s.role === "reviewer" ? "var(--cat-review)" : s.role === "tester" ? "var(--cat-validation)" : s.role === "" ? "var(--cat-planning)" : "var(--cat-general)",
                  flex: "0 0 auto",
                }} />
                <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prettifyAgentName(s.name)}</b>
                {s.model && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>· {s.model.split("-").slice(1, 3).join("-")}</span>}
              </div>
              <span title="dispatches" style={{ textAlign: "right" }}>
                {bounce && <span style={{ color: "var(--yellow)", marginRight: 2 }}>↻</span>}
                {s.dispatches}× <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{bounce ? "bounce" : "call"}</span>
              </span>
              <span title="ok/fail/no-verdict" style={{ textAlign: "right", fontSize: 11 }}>
                {okFail > 0 || s.null_count > 0 ? (
                  <>
                    {s.ok > 0 && <span style={{ color: "var(--green)" }}>✓{s.ok}</span>}
                    {s.fail > 0 && <span style={{ color: "var(--red)", marginLeft: 4 }}>✗{s.fail}</span>}
                    {s.null_count > 0 && <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>?{s.null_count}</span>}
                  </>
                ) : <span style={{ color: "var(--text-dim)" }}>—</span>}
              </span>
              <span title="commits added" style={{ textAlign: "right", color: "var(--text-dim)", fontSize: 11 }}>
                {s.commits > 0 ? `+${s.commits}` : "—"}
              </span>
              <span title="wall time" style={{ textAlign: "right", color: "var(--text-dim)", fontSize: 11 }}>
                {fmtDuration(s.duration_ms) || "—"}
              </span>
              <span title="cost" style={{ textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                <span style={{
                  display: "inline-block", width: 40, height: 4, background: "var(--gray-soft)", borderRadius: 2, overflow: "hidden",
                }}>
                  <span style={{ display: "block", width: `${(share * 100).toFixed(0)}%`, height: "100%", background: "var(--cat-coding)" }} />
                </span>
                ${s.cost_usd.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}

/**
 * Team Flow header — visualizes the path Director took through the playbook
 * as a horizontal sequence of chips, color-coded by sub-agent role. Compact
 * summary so the user can see "where we are" without scrolling the log.
 */
type FlowStep = {
  iter: number;
  action: string;
  label: string;
  role: string;
  cost: number;
  duration_ms: number;
  startedAt: number | null;
  ok: boolean | null | undefined;
  inProgress: boolean;
  /** Set when the step never received a director_subagent_done event AND a
   *  later director_decision came in — typically a tsx-watch reload that
   *  killed the claude CLI process mid-dispatch. The work is gone; Director
   *  retried from the next iteration. */
  aborted?: boolean;
};

function TeamFlowHeader({
  events,
  selectedIter,
  onSelectIter,
}: {
  events: UiEvent[];
  selectedIter: number | null;
  onSelectIter: (iter: number) => void;
}) {
  const steps = useMemo(() => {
    const list: FlowStep[] = [];
    let lastIter = 0;
    for (const e of events) {
      const p = e.payload || {};
      const ts = new Date(e.ts).getTime();
      if (e.type === "director_decision") {
        // A new decision arrived while the previous step never received a
        // director_subagent_done. That happens on resume after the server
        // was killed mid-dispatch (tsx watch reload, crash, etc.) — the
        // claude CLI process was reaped, but the in-flight step is now
        // orphaned. Mark it as aborted so the UI doesn't show it forever
        // in the ⏳ blinking state.
        const prev = list[list.length - 1];
        if (prev?.inProgress && (prev.action === "dispatch" || prev.action === "run_playbook_phase" || prev.action === "dispatch_parallel" || prev.action === "fetch_context" || prev.action === "run_ci_gate")) {
          prev.inProgress = false;
          prev.ok = false;
          prev.aborted = true;
        }
        lastIter = p.iteration ?? lastIter + 1;
        const a = p.action ?? {};
        const action = a.action ?? "?";
        let label = action;
        if (action === "dispatch") label = a.subagent ?? "agent";
        else if (action === "run_playbook_phase") label = a.phase_id ?? "phase";
        else if (action === "run_ci_gate") label = "ci_gate";
        else if (action === "mark_done") label = "✓ done";
        else if (action === "give_up") label = "✗ give_up";
        else if (action === "request_decompose") label = "↯ decompose";
        list.push({ iter: lastIter, action, label, role: "?", cost: p.cost_usd ?? 0, duration_ms: 0, startedAt: ts, ok: undefined, inProgress: true });
      } else if (e.type === "director_dispatch") {
        const last = list[list.length - 1];
        if (last) {
          last.role = p.role ?? last.role;
          if (p.subagent === "ci_gate") last.role = "gate";
          last.startedAt = ts;
        }
      } else if (e.type === "director_subagent_done") {
        const last = list[list.length - 1];
        if (last) {
          last.ok = p.ok;
          last.cost = (last.cost ?? 0) + (p.cost_usd ?? 0);
          last.inProgress = false;
          if (last.startedAt) last.duration_ms = ts - last.startedAt;
        }
      } else if (e.type === "director_end") {
        const last = list[list.length - 1];
        if (last) last.inProgress = false;
      }
    }
    return list;
  }, [events]);
  if (steps.length === 0) return null;

  const colorFor = (s: FlowStep): string => {
    if (s.action === "mark_done") return "var(--cat-validation)";
    if (s.action === "give_up") return "var(--red)";
    if (s.role === "gate") return "var(--cat-planning)";
    if (s.role === "coder") return "var(--cat-coding)";
    if (s.role === "reviewer") return "var(--cat-review)";
    if (s.role === "tester") return "var(--cat-validation)";
    return "var(--cat-general)";
  };

  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
      padding: "10px 12px", marginTop: 12,
      border: "1px solid var(--border)", borderRadius: 8,
      background: "var(--bg-elev)",
    }}>
      <span style={{ fontSize: 11, color: "var(--text-dim)", marginRight: 4 }}>{t("run.flow")}</span>
      {steps.map((s, i) => {
        const c = s.aborted ? "var(--text-dim)" : colorFor(s);
        const okBadge = s.aborted ? "⊘" : s.ok === true ? "✓" : s.ok === false ? "✗" : s.inProgress ? "⏳" : "";
        const isSelected = selectedIter === s.iter;
        return (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              onClick={() => onSelectIter(s.iter)}
              title={
                s.aborted
                  ? `Turn T${s.iter} byl přerušen (server restart / crash uprostřed dispatche). Director ho zopakoval v dalším turnu.`
                  : isSelected
                    ? "Klikni znovu pro zobrazení všech turnů"
                    : `Zobrazit jen log z turnu T${s.iter}`
              }
              style={{
                fontSize: 11,
                padding: "3px 8px", borderRadius: 12,
                background: isSelected
                  ? c
                  : (s.inProgress
                    ? `color-mix(in srgb, ${c} 20%, transparent)`
                    : `color-mix(in srgb, ${c} 13%, transparent)`),
                border: `1px solid ${c}`,
                color: isSelected ? "#fff" : c,
                fontWeight: 600,
                cursor: "pointer",
                animation: s.inProgress ? "pulse 1.6s ease-in-out infinite" : undefined,
              }}
            >
              <span style={{ opacity: 0.7, marginRight: 4 }}>T{s.iter}</span>
              {s.label}
              {okBadge && <span style={{ marginLeft: 4 }}>{okBadge}</span>}
              {s.cost > 0 && <span style={{ opacity: 0.8, marginLeft: 4, fontWeight: 400 }}>${s.cost.toFixed(2)}</span>}
              {s.duration_ms > 0 && <span style={{ opacity: 0.65, marginLeft: 4, fontWeight: 400 }}>· {fmtDuration(s.duration_ms)}</span>}
            </button>
            {i < steps.length - 1 && <span style={{ color: "var(--text-dim)" }}>→</span>}
          </span>
        );
      })}
    </div>
  );
}

function EventRow({ ev }: { ev: UiEvent }) {
  const time = new Date(ev.ts).toLocaleTimeString();
  const tagColor =
    ev.type === "system" ? "var(--accent)" :
    ev.type === "stderr" ? "var(--red)" :
    ev.type === "done" ? "var(--green)" :
    "var(--text-dim)";

  return (
    <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-dim)" }}>{time}</span>{" "}
      <span style={{ color: tagColor, fontWeight: 600 }}>[{ev.type}]</span>{" "}
      <EventBody ev={ev} />
    </div>
  );
}

const EVENT_RENDERERS: Record<string, (payload: any) => ReactNode> = {
  system: (p) => <span>{p?.msg ?? JSON.stringify(p)}</span>,
  stderr: (p) => (
    <span style={{ color: "var(--red)" }}>{String(p).slice(0, 500)}</span>
  ),
  done: (p) => <span>finished — status: <b>{p?.status}</b></span>,
  diff: (p) => (
    <span>
      diff captured for <b>{p?.repo_name}</b> ({p?.diff?.length ?? 0} chars)
    </span>
  ),
  phase_start: (p) => (
    <span style={{ color: "var(--accent)", fontWeight: 600 }}>
      ▶ Phase: {p?.role}{p?.attempt ? ` (attempt ${p.attempt})` : ""}
    </span>
  ),
  phase_end: (p) => <PhaseEnd payload={p} />,
  claude_stream: (p) => <ClaudeLine payload={p} />,
  director_start: (p) => (
    <span style={{ color: "#7c3aed", fontWeight: 600 }}>
      🎬 Director start — budget ${(p?.budget_usd ?? 0).toFixed?.(2) ?? p?.budget_usd}, max {p?.max_iterations} iter, sub-agents: {(p?.available_subagents ?? []).join(", ")}
    </span>
  ),
  director_decision: (p) => (
    <div>
      <span style={{ color: "#7c3aed", fontWeight: 600 }}>
        🧠 Turn {p?.iteration} → {p?.action?.action}
        {p?.action?.subagent ? ` (${p.action.subagent})` : ""}
        {" "}<span style={{ color: "var(--text-dim)", fontWeight: 400 }}>${(p?.cost_usd ?? 0).toFixed?.(3) ?? p?.cost_usd} this · ${(p?.total_cost_usd ?? 0).toFixed?.(2) ?? p?.total_cost_usd} total</span>
      </span>
      {p?.rationale && (
        <div style={{ color: "var(--text-dim)", marginLeft: 12, fontStyle: "italic", marginTop: 2 }}>
          {p.rationale}
        </div>
      )}
      {p?.action?.notes && (
        <div style={{ color: "var(--text)", marginLeft: 12, marginTop: 2, fontSize: 12, whiteSpace: "pre-wrap" }}>
          notes: {String(p.action.notes).slice(0, 400)}
        </div>
      )}
      {p?.action?.summary && (
        <div style={{ color: "var(--green)", marginLeft: 12, marginTop: 2 }}>
          {p.action.summary}
        </div>
      )}
      {p?.action?.reason && (
        <div style={{ color: p.action.action === "give_up" ? "var(--red)" : "var(--yellow)", marginLeft: 12, marginTop: 2 }}>
          {p.action.reason}
        </div>
      )}
    </div>
  ),
  director_thinking: (p) => (
    <span style={{ color: "var(--text-dim)", fontStyle: "italic", whiteSpace: "pre-wrap" }}>
      {String(p?.text_delta ?? "")}
    </span>
  ),
  director_dispatch: (p) => (
    <span style={{ color: "#0ea5e9" }}>
      ↳ dispatching <b>{p?.subagent}</b>{p?.role ? ` (${p.role})` : ""}{p?.model ? ` · ${p.model}` : ""}
      {p?.notes ? `: ${String(p.notes).slice(0, 100)}` : ""}
      {p?.command_preview ? `: ${String(p.command_preview).slice(0, 80)}` : ""}
    </span>
  ),
  director_subagent_done: (p) => {
    const okColor = p?.ok === true ? "var(--green)" : p?.ok === false ? "var(--red)" : "var(--text-dim)";
    return (
      <div>
        <span style={{ color: okColor, fontWeight: 600 }}>
          ↲ {p?.subagent} done — ok={String(p?.ok)}
          {typeof p?.commits_added === "number" ? ` · +${p.commits_added} commits` : ""}
          {typeof p?.cost_usd === "number" ? ` · $${p.cost_usd.toFixed(3)}` : ""}
        </span>
        {p?.summary && (
          <div style={{ color: "var(--text-dim)", marginLeft: 12, marginTop: 2 }}>{p.summary}</div>
        )}
      </div>
    );
  },
  director_end: (p) => (
    <span style={{ color: "#7c3aed", fontWeight: 600 }}>
      🎬 Director end — reason: <b>{p?.reason}</b> · {p?.iterations} turns · ${(p?.total_cost_usd ?? 0).toFixed?.(2) ?? p?.total_cost_usd}
    </span>
  ),
};

function PhaseEnd({ payload }: { payload: any }) {
  const ok =
    payload?.verdict?.ok === true
      ? "ok"
      : payload?.verdict?.ok === false
      ? "not-ok"
      : "no-verdict";
  const color =
    ok === "ok" ? "var(--green)" : ok === "not-ok" ? "var(--red)" : "var(--text-dim)";
  return (
    <div>
      <span style={{ color, fontWeight: 600 }}>
        ◀ Phase end: {payload?.role}{payload?.attempt ? ` (attempt ${payload.attempt})` : ""}
        {payload?.verdict ? ` — verdict: ${ok}` : ""}
        {" "}exit={payload?.exit_code}
      </span>
      {payload?.verdict?.summary && (
        <div style={{ color: "var(--text-dim)", marginLeft: 12, marginTop: 2 }}>
          {payload.verdict.summary}
        </div>
      )}
      {Array.isArray(payload?.verdict?.issues) && payload.verdict.issues.length > 0 && (
        <ul style={{ margin: "4px 0 4px 20px", padding: 0 }}>
          {payload.verdict.issues.map((i: any, idx: number) => (
            <li key={idx} style={{
              color: i.severity === "blocker" ? "var(--red)" : i.severity === "major" ? "var(--yellow)" : "var(--text-dim)",
            }}>
              [{i.severity}] {i.file ?? ""}{i.line ? `:${i.line}` : ""} — {i.message}
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(payload?.verdict?.ran) && payload.verdict.ran.length > 0 && (
        <div style={{ marginLeft: 12, fontSize: 11, color: "var(--text-dim)" }}>
          ran: {payload.verdict.ran.map((c: string) => <code key={c} style={{ marginRight: 8 }}>{c}</code>)}
        </div>
      )}
    </div>
  );
}

function EventBody({ ev }: { ev: UiEvent }) {
  const renderer = EVENT_RENDERERS[ev.type];
  if (renderer) return <>{renderer(ev.payload)}</>;
  return <span>{JSON.stringify(ev.payload).slice(0, 300)}</span>;
}

const CLAUDE_STREAM_RENDERERS: Record<string, (payload: any) => ReactNode> = {
  system: (p) => (
    <span style={{ color: "var(--text-dim)" }}>system: {p.subtype ?? ""}</span>
  ),
  assistant: (p) => <AssistantContent content={p.message?.content ?? []} />,
  user: (p) => <UserContent content={p.message?.content ?? []} />,
  result: (p) => (
    <span style={{ color: "var(--green)" }}>
      result: {String(p.result ?? "").slice(0, 200)}
    </span>
  ),
};

function ClaudeLine({ payload }: { payload: any }) {
  if (typeof payload === "string") {
    return <span style={{ color: "var(--text-dim)" }}>{payload.slice(0, 300)}</span>;
  }
  const renderer = CLAUDE_STREAM_RENDERERS[payload?.type];
  if (renderer) return <>{renderer(payload)}</>;
  return (
    <span style={{ color: "var(--text-dim)" }}>
      {JSON.stringify(payload).slice(0, 200)}
    </span>
  );
}

function AssistantContent({ content }: { content: any[] }) {
  return (
    <div>
      {content.map((c, i) => {
        if (c.type === "text") {
          return <div key={i} style={{ whiteSpace: "pre-wrap" }}>{c.text}</div>;
        }
        if (c.type === "tool_use") {
          return (
            <div key={i} style={{ color: "var(--yellow)" }}>
              → tool <b>{c.name}</b> {summarizeInput(c.input)}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function UserContent({ content }: { content: any[] }) {
  return (
    <div>
      {content.map((c, i) => {
        if (c.type !== "tool_result") return null;
        const text = typeof c.content === "string"
          ? c.content
          : Array.isArray(c.content)
            ? c.content.map((x: any) => x.text ?? "").join("")
            : "";
        return (
          <div key={i} style={{ color: "var(--text-dim)" }}>
            ← tool result: {text.slice(0, 200)}{text.length > 200 ? "…" : ""}
          </div>
        );
      })}
    </div>
  );
}

function summarizeInput(input: any): string {
  if (!input) return "";
  if (typeof input === "string") return input.slice(0, 80);
  const keys = ["file_path", "path", "command", "pattern", "url"];
  for (const k of keys) if (input[k]) return `(${k}: ${String(input[k]).slice(0, 100)})`;
  return "";
}

function DiffView({ diffs }: { diffs: UiEvent[] }) {
  // RunView already deduped to latest-per-repo, so render as-is.
  if (diffs.length === 0) {
    return <div style={{ color: "var(--text-dim)", padding: 20 }}>{t("run.no_diff")}</div>;
  }
  return (
    <div>
      {diffs.map((d) => (
        <div key={d.id} style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px" }}>{d.payload?.repo_name}</h4>
          <DiffPre raw={String(d.payload?.diff ?? "")} />
        </div>
      ))}
    </div>
  );
}

/** Render a unified diff with git-style color overlay:
 *   - file headers (`diff --git`, `index`, `---`, `+++`) muted
 *   - hunk headers (`@@`) accent-colored
 *   - additions (`+`) green background
 *   - deletions (`-`) red background
 *   - context lines neutral
 *  Single <pre> with per-line spans — keeps copy-to-clipboard intact and
 *  preserves whitespace exactly. */
function DiffPre({ raw }: { raw: string }) {
  if (!raw.trim()) {
    return (
      <pre style={diffPreBaseStyle}>{"(no changes)"}</pre>
    );
  }
  const lines = raw.split("\n");
  return (
    <pre style={diffPreBaseStyle}>
      {lines.map((line, i) => {
        let bg = "transparent";
        let color = "var(--text)";
        if (line.startsWith("+++") || line.startsWith("---")) {
          color = "var(--text-dim)";
        } else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity index") || line.startsWith("rename ")) {
          color = "var(--text-dim)";
        } else if (line.startsWith("@@")) {
          color = "#7c5cff";
          bg = "rgba(124, 92, 255, 0.08)";
        } else if (line.startsWith("+")) {
          bg = "rgba(34, 197, 94, 0.15)";
          color = "#15803d";
        } else if (line.startsWith("-")) {
          bg = "rgba(239, 68, 68, 0.15)";
          color = "#b91c1c";
        }
        return (
          <span
            key={i}
            style={{ display: "block", background: bg, color, padding: "0 4px", marginLeft: -4, marginRight: -4 }}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

const diffPreBaseStyle: CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 0",
  fontSize: 12,
  overflow: "auto",
  margin: 0,
  maxHeight: "60vh",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  lineHeight: 1.45,
};

/** Three-button verdict bar shown on completed runs. The chosen verdict
 *  highlights; clicking again clears it. Bad / broken_in_prod prompt for a
 *  short note that becomes part of the project's episodic memory anti-pattern
 *  list. */
function VerdictBar({
  run, busy, onSet,
}: {
  run: Run;
  busy: boolean;
  onSet: (v: import("@ceo/shared").RunUserVerdict | null) => void;
}) {
  const v = run.user_verdict;
  const btn = (label: string, value: import("@ceo/shared").RunUserVerdict, color: string) => (
    <button
      disabled={busy}
      onClick={() => onSet(v === value ? null : value)}
      style={{
        padding: "4px 10px",
        fontSize: 12,
        background: v === value ? color : "transparent",
        color: v === value ? "white" : color,
        border: `1px solid ${color}`,
        borderRadius: 6,
        cursor: busy ? "wait" : "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{
      marginTop: 12,
      display: "flex",
      gap: 8,
      alignItems: "center",
      padding: "8px 10px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border)",
      borderRadius: 6,
      fontSize: 12,
    }}>
      <span style={{ color: "var(--text-dim)" }}>{t("verdict.title")}</span>
      {btn(t("verdict.good"), "good", "#16a34a")}
      {btn(t("verdict.bad"), "bad", "#dc2626")}
      {btn(t("verdict.broken_in_prod"), "broken_in_prod", "#b91c1c")}
      {run.user_verdict_note && (
        <span style={{ color: "var(--text-dim)", fontStyle: "italic", marginLeft: 8 }}>
          „{run.user_verdict_note.slice(0, 120)}{run.user_verdict_note.length > 120 ? "…" : ""}"
        </span>
      )}
    </div>
  );
}
