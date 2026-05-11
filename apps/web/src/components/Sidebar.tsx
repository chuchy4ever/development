import type { Project } from "@ceo/shared";
import { t, useLang } from "../i18n";

interface Props {
  projects: Project[];
  activeId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onSelectAdmin: () => void;
  onCreate: () => void;
}

export function Sidebar({ projects, activeId, isAdmin, onSelect, onSelectAdmin, onCreate }: Props) {
  const [lang, setLang] = useLang();
  return (
    <aside className="sidebar">
      <h1>CEOrchestration</h1>
      <div className="projects">
        {projects.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: "12px", fontSize: "12px" }}>
            No projects yet.
          </div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            className={`project-item ${p.id === activeId && !isAdmin ? "active" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            {p.name}
          </div>
        ))}
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
