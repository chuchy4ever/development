import { useEffect, useState } from "react";
import type { AgentTemplate, WorkflowPreset } from "@ceo/shared";
import { api } from "../api";
import type { AdminSection, Route } from "../router";

interface Props {
  route: Route;
  navigate: (next: Partial<Route>) => void;
}

export function AdminView({ route, navigate }: Props) {
  const section: AdminSection = route.adminSection;
  return (
    <>
      <div className="toolbar">
        <div>
          <h2>Admin</h2>
          <div className="meta">Cross-project administration</div>
        </div>
      </div>
      <div className="tabs">
        {(["overview", "templates", "activity"] as AdminSection[]).map((s) => (
          <div
            key={s}
            className={`tab ${section === s ? "active" : ""}`}
            onClick={() => navigate({ adminSection: s })}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </div>
        ))}
      </div>
      <div className="content">
        {section === "overview" && <Overview onProjectClick={(id) => navigate({ view: "project", projectId: id, tab: "board" })} />}
        {section === "templates" && <Templates />}
        {section === "activity" && <Activity onTicketClick={(pid, tid) => navigate({ view: "project", projectId: pid, tab: "board", ticketId: tid })} />}
      </div>
    </>
  );
}

// ---- Overview --------------------------------------------------------------

function Overview({ onProjectClick }: { onProjectClick: (id: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminOverview>> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    function tick() {
      api.adminOverview().then((d) => active && setData(d)).catch((e) => active && setErr(e.message));
    }
    tick();
    const t = setInterval(tick, 5000);
    return () => { active = false; clearInterval(t); };
  }, []);

  if (err) return <div style={{ color: "var(--red)" }}>{err}</div>;
  if (!data) return <div style={{ color: "var(--text-dim)" }}>Loading…</div>;

  const sumRunsByDay = data.cost_last_7_days.reduce((s, d) => s + d.runs, 0);
  const maxDailyCost = Math.max(0.0001, ...data.cost_last_7_days.map((d) => d.cost));

  return (
    <div style={{ maxWidth: 1100, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <Stat label="Total cost" value={`$${data.total_cost_usd.toFixed(4)}`} accent="var(--yellow)" />
        <Stat label="Runs total" value={String(data.runs_total)} sub={`${sumRunsByDay} in last 7d`} />
        <Stat label="Projects" value={String(data.projects_count)} />
        <Stat label="Agents" value={String(data.agents_count)} />
      </div>

      {/* Cost by project */}
      <div className="settings-section">
        <h3>Cost by project</h3>
        {data.cost_by_project.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No projects yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.cost_by_project.map((p) => {
              const cap = p.daily_cost_cap_usd;
              const pct = cap && cap > 0 ? Math.min(100, (p.today_cost_usd / cap) * 100) : 0;
              const overCap = cap && cap > 0 && p.today_cost_usd >= cap;
              const nearCap = cap && cap > 0 && pct >= 80 && !overCap;
              return (
                <div
                  key={p.project_id}
                  onClick={() => onProjectClick(p.project_id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    background: "var(--bg)",
                    border: `1px solid ${overCap ? "var(--red)" : nearCap ? "var(--yellow)" : "var(--border)"}`,
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <span style={{ flex: 1, fontWeight: 600 }}>{p.project_name}</span>
                  <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{p.runs} runs</span>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 160 }}>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      today: <b style={{ color: overCap ? "var(--red)" : "var(--text)" }}>${p.today_cost_usd.toFixed(4)}</b>
                      {cap && <> / <b>${cap.toFixed(2)}</b></>}
                    </span>
                    {cap && cap > 0 && (
                      <div style={{ width: 140, height: 4, background: "var(--gray-soft)", borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
                        <div style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: overCap ? "var(--red)" : nearCap ? "var(--yellow)" : "var(--green)",
                        }} />
                      </div>
                    )}
                  </div>
                  <span style={{ color: "var(--yellow)", fontWeight: 700, minWidth: 80, textAlign: "right" }}>
                    ${p.total_cost_usd.toFixed(4)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Last 7 days */}
      <div className="settings-section">
        <h3>Spend — last 7 days</h3>
        {data.cost_last_7_days.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No runs in the last week.</div>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, padding: "8px 0" }}>
            {data.cost_last_7_days.map((d) => (
              <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div title={`$${d.cost.toFixed(4)} · ${d.runs} runs`}
                  style={{
                    width: "100%",
                    background: "linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%)",
                    borderRadius: "4px 4px 0 0",
                    height: `${Math.max(4, (d.cost / maxDailyCost) * 100)}%`,
                    minHeight: 4,
                  }}
                />
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{d.date.slice(5)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status counts */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="settings-section">
          <h3>Tickets by status</h3>
          <StatusBreakdown counts={data.tickets_by_status} />
        </div>
        <div className="settings-section">
          <h3>Runs by status</h3>
          <StatusBreakdown counts={data.runs_by_status} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="settings-section" style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)" }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent ?? "var(--text)", marginTop: 4 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StatusBreakdown({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <div style={{ color: "var(--text-dim)", fontSize: 12 }}>(none)</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {entries.map(([k, n]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: "var(--text-dim)" }}>{k}</span>
          <span style={{ fontWeight: 600 }}>{n}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Templates -------------------------------------------------------------

function Templates() {
  const [list, setList] = useState<WorkflowPreset[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  // Esc closes the import dialog when it's open.
  useEffect(() => {
    if (!showImport) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setShowImport(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [showImport]);

  async function refresh() {
    try {
      setList(await api.listWorkflowPresets());
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { refresh(); }, []);

  async function del(key: string) {
    if (!confirm(`Delete user template "${key}"?`)) return;
    setBusy(true);
    try {
      await api.deleteWorkflowPreset(key);
      await refresh();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  function exportTemplate(t: WorkflowPreset) {
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${t.key}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importSubmit() {
    setBusy(true); setErr(null);
    try {
      const parsed = JSON.parse(importText);
      await api.importWorkflowPreset(parsed);
      setImportText("");
      setShowImport(false);
      await refresh();
    } catch (e: any) {
      setErr(`Import failed: ${e.message}`);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Playbook templates</h3>
        <button className="primary" onClick={() => setShowImport(true)} disabled={busy}>
          Import JSON…
        </button>
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Templates live in <code>~/.ceo/templates/&lt;key&gt;.json</code> for user templates;
        built-ins are bundled in code. Apply happens from a project's Workflow tab.
      </p>
      {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((t) => (
          <div key={t.key} className="repo-item" style={{ alignItems: "flex-start" }}>
            <div className="info" style={{ flex: 1 }}>
              <div className="name">
                {t.name}
                <span style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: t.source === "builtin" ? "var(--accent)" : "var(--green)",
                  color: "white",
                  marginLeft: 8,
                }}>{t.source}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: 8, fontFamily: "ui-monospace, monospace" }}>
                  {t.key}
                </span>
              </div>
              <div className="url" style={{ marginTop: 4, color: "var(--text-dim)" }}>
                {t.description}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {t.agents.length} agent(s), {t.phases.length} phases
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => exportTemplate(t)} disabled={busy}>Export</button>
              {t.source === "user" && (
                <button className="danger" onClick={() => del(t.key)} disabled={busy}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showImport && (
        <div className="modal-backdrop" onClick={() => setShowImport(false)}>
          <div className="modal" role="dialog" aria-modal="true" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
            <h3>Import workflow template</h3>
            <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
              Paste a template JSON (exported from another instance, or a curated team setup).
              The template's <code>key</code> determines the file name.
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={20}
              placeholder='{"key":"my-team","name":"My team",...}'
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
            <div className="form-actions">
              <button onClick={() => setShowImport(false)} disabled={busy}>Cancel</button>
              <button className="primary" onClick={importSubmit} disabled={busy || !importText.trim()}>
                {busy ? "Importing..." : "Import"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <SkillTemplatesAdmin />
      </div>
    </div>
  );
}

// ---- Skill templates admin -------------------------------------------------

/**
 * Editor for global Skill (=agent) templates. Edits propagate to every
 * project that has imported the template (template_key set on agent →
 * server overlays template fields on read). Built-ins can be customized;
 * "reset" deletes the user override file and falls back to the in-code
 * built-in.
 */
function SkillTemplatesAdmin() {
  const [list, setList] = useState<(AgentTemplate & { is_builtin?: boolean; is_user_override?: boolean })[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const fresh = await api.listAgentTemplates() as any;
      setList(fresh);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="settings-section">
      <h3 style={{ margin: 0, marginBottom: 12 }}>Skill templates (library)</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0, marginBottom: 12 }}>
        Specialists shared across projects. Edits here propagate to every project that imported the template.
        Built-ins can be customized; reset to revert to the version shipped with ceo.
      </p>
      {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.map((t) => (
          <div key={t.key} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "10px 12px", background: "var(--bg)",
            border: "1px solid var(--border)", borderRadius: 6,
            fontSize: 13,
          }}>
            <code style={{ background: "var(--gray-soft)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>{t.key}</code>
            <span style={{ flex: 1 }}>
              <b>{t.name}</b>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                ({t.role}{t.model ? `, ${t.model}` : ""})
              </span>
            </span>
            {t.is_user_override && (
              <span title="Customized — overrides built-in" style={{
                fontSize: 10, padding: "1px 6px", borderRadius: 8,
                background: "rgba(245, 158, 11, 0.12)", color: "#92400e",
                border: "1px solid rgba(245, 158, 11, 0.3)",
              }}>customized</span>
            )}
            {!t.is_builtin && (
              <span title="User-defined (not a built-in)" style={{
                fontSize: 10, padding: "1px 6px", borderRadius: 8,
                background: "rgba(124, 58, 237, 0.12)", color: "#5b21b6",
                border: "1px solid rgba(124, 58, 237, 0.3)",
              }}>user</span>
            )}
            <button onClick={() => setEditing(t.key)}>Edit</button>
            {t.is_user_override && (
              <button
                onClick={async () => {
                  if (!confirm(`Reset template "${t.key}" to built-in defaults?`)) return;
                  try { await api.resetAgentTemplate(t.key); } catch (e: any) { alert(e.message); return; }
                  refresh();
                }}
                title="Delete user override; revert to built-in"
              >Reset</button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <SkillTemplateEditor
          templateKey={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function SkillTemplateEditor({
  templateKey,
  onClose,
  onSaved,
}: {
  templateKey: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tpl, setTpl] = useState<AgentTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getAgentTemplate(templateKey).then(setTpl).catch((e: any) => setErr(e.message));
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [templateKey, onClose]);

  if (!tpl) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" role="dialog" aria-modal="true" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
          {err ? <div style={{ color: "var(--red)" }}>{err}</div> : <div>Loading…</div>}
        </div>
      </div>
    );
  }

  async function save() {
    if (!tpl) return;
    setBusy(true); setErr(null);
    try {
      await api.saveAgentTemplate(templateKey, tpl);
      onSaved();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal" role="dialog" aria-modal="true"
        style={{ width: 720, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Edit template: <code>{templateKey}</code></h3>
          <button onClick={onClose} style={{ background: "transparent", border: 0, fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ overflow: "auto", paddingRight: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
            <div className="form-row">
              <label>Name</label>
              <input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Role</label>
              <select value={tpl.role} onChange={(e) => setTpl({ ...tpl, role: e.target.value as AgentTemplate["role"] })}>
                <option value="coder">coder</option>
                <option value="reviewer">reviewer</option>
                <option value="tester">tester</option>
              </select>
            </div>
            <div className="form-row">
              <label>Model</label>
              <input value={tpl.model ?? ""} onChange={(e) => setTpl({ ...tpl, model: e.target.value || null })} placeholder="(default)" />
            </div>
          </div>
          <div className="form-row">
            <label>Description (1 line, shown in pickers)</label>
            <input value={tpl.description ?? ""} onChange={(e) => setTpl({ ...tpl, description: e.target.value })} />
          </div>
          <div className="form-row">
            <label>System prompt</label>
            <textarea
              value={tpl.system_prompt}
              onChange={(e) => setTpl({ ...tpl, system_prompt: e.target.value })}
              rows={14}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>Allowed tools (CSV)</label>
            <input
              value={(tpl.allowed_tools ?? []).join(", ")}
              onChange={(e) => setTpl({
                ...tpl,
                allowed_tools: e.target.value.trim()
                  ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                  : null,
              })}
              placeholder="Read, Edit, Bash, …"
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div className="form-row">
              <label>Default skill category (used when imported)</label>
              <select
                value={tpl.default_skill_category ?? ""}
                onChange={(e) => setTpl({ ...tpl, default_skill_category: (e.target.value || undefined) as any })}
              >
                <option value="">(auto)</option>
                <option value="planning">Planning</option>
                <option value="coding">Coding</option>
                <option value="review">Review</option>
                <option value="validation">Validation (gates)</option>
                <option value="closing">Closing</option>
                <option value="infra">Infra</option>
                <option value="general">General</option>
              </select>
            </div>
            <div className="form-row">
              <label>Category (free text — agent definition)</label>
              <input value={tpl.category} onChange={(e) => setTpl({ ...tpl, category: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <label>Default notes (appended to every skill instance on import)</label>
            <textarea
              value={tpl.default_notes ?? ""}
              onChange={(e) => setTpl({ ...tpl, default_notes: e.target.value || null })}
              rows={4}
              placeholder="(empty)"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
        </div>
        {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
        <div className="form-actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Activity --------------------------------------------------------------

function Activity({ onTicketClick }: { onTicketClick: (projectId: string, ticketId: string) => void }) {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof api.adminRecentRuns>>>([]);
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof api.adminMetrics>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(7);

  useEffect(() => {
    let active = true;
    function tick() {
      api.adminRecentRuns(50).then((r) => active && setRuns(r)).catch((e) => active && setErr(e.message));
      api.adminMetrics(windowDays).then((m) => active && setMetrics(m)).catch((e) => active && setErr(e.message));
    }
    tick();
    const t = setInterval(tick, 5000);
    return () => { active = false; clearInterval(t); };
  }, [windowDays]);

  if (err) return <div style={{ color: "var(--red)" }}>{err}</div>;

  const statusColor = (s: string): { fg: string; bg: string } => ({
    succeeded: { fg: "#047857", bg: "var(--green-soft)" },
    failed: { fg: "#b91c1c", bg: "var(--red-soft)" },
    running: { fg: "#1d4ed8", bg: "var(--blue-soft)" },
    cancelled: { fg: "#475569", bg: "var(--gray-soft)" },
    pending: { fg: "#475569", bg: "var(--gray-soft)" },
  }[s] ?? { fg: "#475569", bg: "var(--gray-soft)" });

  const fmtMs = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${(ms / 60000).toFixed(1)} min`;
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      {metrics && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Metrics — last {metrics.window_days} days</h3>
            <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
              <option value={1}>last 1 day</option>
              <option value={7}>last 7 days</option>
              <option value={30}>last 30 days</option>
              <option value={90}>last 90 days</option>
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
            <MetricCard
              label="Total runs"
              value={Object.values(metrics.run_counts).reduce((a, b) => a + b, 0).toString()}
              hint={Object.entries(metrics.run_counts)
                .map(([k, v]) => `${k}: ${v}`)
                .join("  ·  ")}
            />
            <MetricCard
              label="Failure rate"
              value={`${metrics.failure_rate_pct.toFixed(1)}%`}
              tone={metrics.failure_rate_pct > 30 ? "danger" : metrics.failure_rate_pct > 10 ? "warn" : "ok"}
              hint={`${metrics.run_counts.failed ?? 0} failed / ${(metrics.run_counts.succeeded ?? 0) + (metrics.run_counts.failed ?? 0)} terminal`}
            />
            <MetricCard
              label="Total cost"
              value={`$${metrics.total_cost_usd.toFixed(2)}`}
              tone="warn"
            />
            <MetricCard
              label="Awaiting approval"
              value={(metrics.run_counts.awaiting_approval ?? 0).toString()}
              tone={(metrics.run_counts.awaiting_approval ?? 0) > 0 ? "warn" : "ok"}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <h4 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Top failing phases</h4>
              {metrics.top_failing_phases.length === 0 ? (
                <div style={{ color: "var(--text-dim)", fontSize: 12 }}>None — clean window.</div>
              ) : (
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <tbody>
                    {metrics.top_failing_phases.map((p) => (
                      <tr key={p.phase_id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "4px 0", fontFamily: "ui-monospace, monospace" }}>{p.phase_id}</td>
                        <td style={{ padding: "4px 0", textAlign: "right", color: "var(--red)", fontWeight: 600 }}>
                          {p.fails}× failed
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <h4 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Slowest phases (avg duration)</h4>
              {metrics.longest_phases.length === 0 ? (
                <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  No duration data yet. (Only shell tasks emit duration_ms; agent phases coming.)
                </div>
              ) : (
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <tbody>
                    {metrics.longest_phases.map((p) => (
                      <tr key={p.phase_id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "4px 0", fontFamily: "ui-monospace, monospace" }}>{p.phase_id}</td>
                        <td style={{ padding: "4px 0", textAlign: "right" }}>
                          <b>{fmtMs(p.avg_duration_ms)}</b>
                          <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>· n={p.samples}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          {metrics.daily_series.length > 0 && (
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <h4 style={{ marginTop: 0, marginBottom: 8, fontSize: 13 }}>Daily activity</h4>
              <div style={{ display: "grid", gridTemplateColumns: `120px repeat(${metrics.daily_series.length}, 1fr)`, gap: 6, fontSize: 11 }}>
                <div style={{ color: "var(--text-dim)" }}>date</div>
                {metrics.daily_series.map((d) => (
                  <div key={`d-${d.date}`} style={{ textAlign: "center", color: "var(--text-dim)", fontFamily: "ui-monospace, monospace" }}>
                    {d.date.slice(5)}
                  </div>
                ))}
                <div style={{ color: "#047857" }}>succeeded</div>
                {metrics.daily_series.map((d) => (
                  <div key={`s-${d.date}`} style={{ textAlign: "center", fontWeight: 600 }}>{d.succeeded}</div>
                ))}
                <div style={{ color: "#b91c1c" }}>failed</div>
                {metrics.daily_series.map((d) => (
                  <div key={`f-${d.date}`} style={{ textAlign: "center", fontWeight: 600, color: d.failed > 0 ? "#b91c1c" : "inherit" }}>
                    {d.failed}
                  </div>
                ))}
                <div style={{ color: "var(--yellow)" }}>cost (USD)</div>
                {metrics.daily_series.map((d) => (
                  <div key={`c-${d.date}`} style={{ textAlign: "center", fontFamily: "ui-monospace, monospace" }}>
                    {d.cost > 0 ? `$${d.cost.toFixed(2)}` : "—"}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <h3 style={{ margin: "0 0 6px" }}>Recent runs (last 50)</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Click a row to jump to the ticket.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {runs.length === 0 && (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No runs yet.</div>
        )}
        {runs.map((r) => {
          const c = statusColor(r.status);
          const ago = relativeTime(r.created_at);
          return (
            <div
              key={r.run_id}
              onClick={() => onTicketClick(r.project_id, r.ticket_id)}
              style={{
                display: "grid",
                gridTemplateColumns: "70px 80px 1fr 200px 120px 80px 70px",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <span style={{
                padding: "2px 8px", borderRadius: 999, fontSize: 10,
                fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                color: c.fg, background: c.bg, textAlign: "center",
              }}>{r.status}</span>
              {r.ticket_key ? (
                <span className="ticket-key">{r.ticket_key}</span>
              ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.ticket_title}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {r.current_agent_name ?? r.agent_role}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{r.project_name}</span>
              <span style={{ color: "var(--yellow)", fontWeight: 600, textAlign: "right", fontSize: 11 }}>
                {typeof r.total_cost_usd === "number" ? `$${r.total_cost_usd.toFixed(4)}` : "—"}
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: 10, textAlign: "right" }}>{ago}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricCard({ label, value, hint, tone = "neutral" }: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn" | "danger" | "neutral";
}) {
  const accent = tone === "ok" ? "#047857"
    : tone === "warn" ? "#b45309"
    : tone === "danger" ? "#b91c1c"
    : "var(--text)";
  return (
    <div className="settings-section" style={{ marginBottom: 0, padding: 14 }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, lineHeight: 1.2, marginTop: 2 }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
