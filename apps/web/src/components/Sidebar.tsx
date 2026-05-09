import type { Project } from "@ceo/shared";

interface Props {
  projects: Project[];
  activeId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onSelectAdmin: () => void;
  onCreate: () => void;
}

export function Sidebar({ projects, activeId, isAdmin, onSelect, onSelectAdmin, onCreate }: Props) {
  return (
    <aside className="sidebar">
      <h1>ceo</h1>
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
      </div>
    </aside>
  );
}
