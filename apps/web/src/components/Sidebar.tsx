import { useEffect, useState } from "react";
import type { Project } from "@ceo/shared";
import { api } from "../api";
import { t, useLang } from "../i18n";

interface Props {
  projects: Project[];
  activeId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onSelectAdmin: () => void;
  onCreate: () => void;
}

interface ProjectSummary {
  active_runs: number;
  backlog_count: number;
  today_cost_usd: number;
}

/** Poll per-project activity summary so the sidebar always reflects current
 *  state. 5s cadence is responsive enough for the kanban-style flow without
 *  hammering the API. */
function useProjectsSummary(): Record<string, ProjectSummary> {
  const [byId, setById] = useState<Record<string, ProjectSummary>>({});
  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      try {
        const rows = await api.projectsSummary();
        if (!alive) return;
        const next: Record<string, ProjectSummary> = {};
        for (const r of rows) {
          next[r.id] = {
            active_runs: r.active_runs,
            backlog_count: r.backlog_count,
            today_cost_usd: r.today_cost_usd,
          };
        }
        setById(next);
      } catch { /* sidebar is best-effort */ }
    };
    fetchOnce();
    const handle = window.setInterval(fetchOnce, 5000);
    return () => { alive = false; window.clearInterval(handle); };
  }, []);
  return byId;
}

export function Sidebar({ projects, activeId, isAdmin, onSelect, onSelectAdmin, onCreate }: Props) {
  const [lang, setLang] = useLang();
  const summary = useProjectsSummary();
  return (
    <aside className="sidebar">
      <h1>CEOrchestration</h1>
      <div className="projects">
        {projects.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: "12px", fontSize: "12px" }}>
            No projects yet.
          </div>
        )}
        {projects.map((p) => {
          const s = summary[p.id];
          return (
            <div
              key={p.id}
              className={`project-item ${p.id === activeId && !isAdmin ? "active" : ""}`}
              onClick={() => onSelect(p.id)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                {s && (s.active_runs > 0 || s.backlog_count > 0) && (
                  <span style={{ display: "flex", gap: 4, fontSize: 10, fontWeight: 600, flexShrink: 0 }}>
                    {s.active_runs > 0 && (
                      <span
                        title={`${s.active_runs} běžící run${s.active_runs === 1 ? "" : "y"}`}
                        style={{
                          background: "var(--accent)", color: "#fff",
                          padding: "1px 6px", borderRadius: 8,
                          minWidth: 18, textAlign: "center",
                        }}
                      >
                        ▶ {s.active_runs}
                      </span>
                    )}
                    {s.backlog_count > 0 && (
                      <span
                        title={`${s.backlog_count} ticket${s.backlog_count === 1 ? "" : "ů"} v backlogu`}
                        style={{
                          background: "var(--bg-elev)", color: "var(--text-dim)",
                          padding: "1px 6px", borderRadius: 8,
                          border: "1px solid var(--border)",
                          minWidth: 18, textAlign: "center",
                        }}
                      >
                        {s.backlog_count}
                      </span>
                    )}
                  </span>
                )}
              </div>
              {s && s.today_cost_usd > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  dnes ${s.today_cost_usd.toFixed(2)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", padding: 8 }}>
        <div
          className={`project-item ${isAdmin ? "active" : ""}`}
          onClick={onSelectAdmin}
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span style={{
            display: "inline-block",
            width: 16, height: 16,
            borderRadius: 4,
            background: "linear-gradient(135deg, #6d4dff 0%, #ec4899 100%)",
            color: "white",
            fontSize: 11,
            fontWeight: 700,
            textAlign: "center",
            lineHeight: "16px",
          }}>⚙</span>
          Admin
        </div>
      </div>
      <div className="footer">
        <button className="primary" style={{ width: "100%" }} onClick={onCreate}>
          + New project
        </button>
        <div style={{
          display: "flex", gap: 4, marginTop: 8,
          fontSize: 11, justifyContent: "center",
        }}>
          {(["cs", "en"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              style={{
                padding: "2px 10px", fontSize: 11, borderRadius: 10,
                background: lang === l ? "var(--accent)" : "transparent",
                color: lang === l ? "#fff" : "var(--text-dim)",
                border: `1px solid ${lang === l ? "var(--accent)" : "var(--border)"}`,
              }}
              title={t(`lang.${l}`)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
