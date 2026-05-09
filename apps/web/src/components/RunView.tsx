import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Run } from "@ceo/shared";
import { api, streamRunEvents } from "../api";

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

const FILTER_LABELS: Record<FilterKey, string> = {
  director: "🎬 Director",
  tools: "🔧 Tools",
  phases: "▶ Phases",
  system: "ℹ System",
  errors: "❗ Errors",
  diffs: "📝 Diffs",
};

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
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<UiEvent[]>([]);
  const [activeTab, setActiveTab] = useState<"log" | "diff">("log");
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    api.getRun(runId).then((r) => {
      if (active) setRun(r);
    });

    // Batch incoming events: SSE can fire dozens per second during a busy run.
    // Without batching that's one re-render per event.
    const queue: UiEvent[] = [];
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (queue.length === 0) return;
      const batch = queue.splice(0, queue.length);
      setEvents((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = batch.filter((e) => !seen.has(e.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
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

  const diffs = events.filter((e) => e.type === "diff");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  async function handleCancel() {
    if (!confirm("Cancel this run? The Coder process will be terminated.")) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const r = await api.cancelRun(runId);
      setRun(r);
    } catch (e: any) {
      setActionMsg(`Cancel failed: ${e.message}`);
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
      setActionMsg(`Open PR failed: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  const isRunning = run?.status === "running" || run?.status === "pending";
  const isAwaitingApproval = run?.status === "awaiting_approval";
  const canPr = run?.status === "succeeded";

  // Most recent awaiting_approval event (so we can show the message even after
  // events list grows long).
  const lastApprovalEvent = [...events]
    .reverse()
    .find((e) => e.type === "awaiting_approval");
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
      setActionMsg(`Approve failed: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleReject() {
    if (!confirm("Reject this approval? The run will retry the upstream phase if a retry target is set, otherwise fail.")) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const r = await api.rejectRun(runId, approvalNote || undefined);
      setRun(r);
      setApprovalNote("");
    } catch (e: any) {
      setActionMsg(`Reject failed: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: "min(1100px, 95vw)", height: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Run {runId.slice(0, 8)}</h3>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
              {run ? (
                <>
                  <span style={{ marginRight: 12 }}>status: <b>{run.status}</b></span>
                  <span style={{ marginRight: 12 }}>branch: <code>{run.branch}</code></span>
                  {run.exit_code != null && <span style={{ marginRight: 12 }}>exit: {run.exit_code}</span>}
                  {typeof run.total_cost_usd === "number" && (
                    <span style={{ marginRight: 12 }}>
                      cost: <b style={{ color: "var(--yellow)" }}>${run.total_cost_usd.toFixed(4)}</b>
                    </span>
                  )}
                </>
              ) : "loading..."}
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
                <b>Failure reason:</b> {run.error}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {isRunning && (
              <button className="danger" onClick={handleCancel} disabled={actionBusy}>
                Cancel
              </button>
            )}
            {canPr && (
              <button className="primary" onClick={handleOpenPr} disabled={actionBusy}>
                {actionBusy ? "..." : "Open PR"}
              </button>
            )}
            <button onClick={onClose}>Close</button>
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
              <b>Awaiting your approval</b>
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
              placeholder="optional note (audit trail)"
              style={{ width: "100%", marginBottom: 8, fontSize: 12 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" onClick={handleApprove} disabled={actionBusy}>
                {actionBusy ? "..." : "✓ Approve & continue"}
              </button>
              <button className="danger" onClick={handleReject} disabled={actionBusy}>
                ✗ Reject
              </button>
            </div>
          </div>
        )}

        {events.length > 0 && <TeamFlowHeader events={events} />}

        <div className="tabs" style={{ marginTop: 12, paddingLeft: 0 }}>
          <div
            className={`tab ${activeTab === "log" ? "active" : ""}`}
            onClick={() => setActiveTab("log")}
          >
            Live log ({events.length})
          </div>
          <div
            className={`tab ${activeTab === "diff" ? "active" : ""}`}
            onClick={() => setActiveTab("diff")}
          >
            Diff ({diffs.length})
          </div>
          <div style={{ flex: 1 }} />
          {activeTab === "log" && events.length > 0 && (
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
              title="Download all events as JSON for debug"
              style={{ marginRight: 8, alignSelf: "center", fontSize: 11 }}
            >
              ⬇ Export log
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "12px 0", minHeight: 0 }}>
          {activeTab === "log" ? (
            <LogView events={events} />
          ) : (
            <DiffView diffs={diffs} />
          )}
          <div ref={logEnd} />
        </div>
      </div>
    </div>
  );
}

function LogView({ events }: { events: UiEvent[] }) {
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    director: true,
    tools: false,    // claude_stream is noisy by default
    phases: true,
    system: true,
    errors: true,
    diffs: true,
  });
  // Count by category for chip badges
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { director: 0, tools: 0, phases: 0, system: 0, errors: 0, diffs: 0 };
    for (const e of events) {
      const k = classifyEvent(e.type);
      if (k) c[k]++;
    }
    return c;
  }, [events]);
  const filtered = useMemo(
    () => events.filter((e) => {
      const k = classifyEvent(e.type);
      return k ? filters[k] : true;
    }),
    [events, filters],
  );
  return (
    <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}>
      <div style={{
        position: "sticky", top: 0, zIndex: 5,
        display: "flex", flexWrap: "wrap", gap: 6,
        padding: "6px 0 8px",
        background: "var(--bg)",
        borderBottom: "1px solid var(--border)",
        marginBottom: 6,
      }}>
        {(Object.keys(FILTER_LABELS) as FilterKey[]).map((k) => (
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
            {FILTER_LABELS[k]} <span style={{ opacity: 0.7 }}>· {counts[k]}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setFilters({ director: true, tools: true, phases: true, system: true, errors: true, diffs: true })}
          style={{ fontSize: 11 }}
        >show all</button>
      </div>
      {filtered.length === 0 && (
        <div style={{ color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
          No events match the active filters.
        </div>
      )}
      {filtered.map((ev) => (
        <EventRow key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

/**
 * Team Flow header — visualizes the path Director took through the playbook
 * as a horizontal sequence of chips, color-coded by sub-agent role. Compact
 * summary so the user can see "where we are" without scrolling the log.
 */
function TeamFlowHeader({ events }: { events: UiEvent[] }) {
  // Build a sequence of director_decision + dispatch + done events.
  type Step = {
    iter: number;
    action: string;
    label: string;
    role: string;
    cost: number;
    ok: boolean | null | undefined;
    inProgress: boolean;
  };
  const steps: Step[] = [];
  let lastIter = 0;
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === "director_decision") {
      lastIter = p.iteration ?? lastIter + 1;
      const a = p.action ?? {};
      const action = a.action ?? "?";
      let label = action;
      if (action === "dispatch") label = a.subagent ?? "agent";
      else if (action === "run_playbook_phase") label = a.phase_id ?? "phase";
      else if (action === "use_playbook") label = `📖 ${a.playbook ?? "playbook"}`;
      else if (action === "run_ci_gate") label = "ci_gate";
      else if (action === "mark_done") label = "✓ done";
      else if (action === "give_up") label = "✗ give_up";
      else if (action === "request_decompose") label = "↯ decompose";
      steps.push({ iter: lastIter, action, label, role: "?", cost: p.cost_usd ?? 0, ok: undefined, inProgress: true });
    } else if (e.type === "director_dispatch") {
      const last = steps[steps.length - 1];
      if (last) {
        last.role = p.role ?? last.role;
        if (p.subagent === "ci_gate") last.role = "gate";
      }
    } else if (e.type === "director_subagent_done") {
      const last = steps[steps.length - 1];
      if (last) {
        last.ok = p.ok;
        last.cost = (last.cost ?? 0) + (p.cost_usd ?? 0);
        last.inProgress = false;
      }
    } else if (e.type === "director_end") {
      const last = steps[steps.length - 1];
      if (last) last.inProgress = false;
    }
  }
  if (steps.length === 0) return null;

  const colorFor = (s: Step): string => {
    if (s.action === "mark_done") return "#16a34a";
    if (s.action === "give_up") return "#dc2626";
    if (s.action === "use_playbook") return "#7c3aed";
    if (s.role === "gate") return "#0891b2";
    if (s.role === "coder") return "#7c5cff";
    if (s.role === "reviewer") return "#d29922";
    if (s.role === "tester") return "#16a34a";
    return "#6b7280";
  };

  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
      padding: "10px 12px", marginTop: 12,
      border: "1px solid var(--border)", borderRadius: 8,
      background: "var(--bg-elev)",
    }}>
      <span style={{ fontSize: 11, color: "var(--text-dim)", marginRight: 4 }}>FLOW:</span>
      {steps.map((s, i) => {
        const c = colorFor(s);
        const okBadge = s.ok === true ? "✓" : s.ok === false ? "✗" : s.inProgress ? "⏳" : "";
        return (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{
              fontSize: 11,
              padding: "3px 8px", borderRadius: 12,
              background: s.inProgress ? `${c}33` : `${c}22`,
              border: `1px solid ${c}`,
              color: c,
              fontWeight: 600,
              animation: s.inProgress ? "pulse 1.6s ease-in-out infinite" : undefined,
            }}>
              <span style={{ opacity: 0.6, marginRight: 4 }}>T{s.iter}</span>
              {s.label}
              {okBadge && <span style={{ marginLeft: 4 }}>{okBadge}</span>}
              {s.cost > 0 && <span style={{ opacity: 0.7, marginLeft: 4, fontWeight: 400 }}>${s.cost.toFixed(2)}</span>}
            </span>
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
  if (diffs.length === 0) {
    return <div style={{ color: "var(--text-dim)", padding: 20 }}>No diff yet.</div>;
  }
  return (
    <div>
      {diffs.map((d) => (
        <div key={d.id} style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px" }}>{d.payload?.repo_name}</h4>
          <pre style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            overflow: "auto",
            margin: 0,
            maxHeight: "60vh",
          }}>{d.payload?.diff || "(no changes)"}</pre>
        </div>
      ))}
    </div>
  );
}
