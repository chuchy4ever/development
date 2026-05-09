import { useEffect, useState } from "react";
import type { Project, ProjectWithRepos } from "@ceo/shared";
import { api } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { CreateProjectModal } from "./components/CreateProjectModal";
import { AdminView } from "./components/AdminView";
import { useRoute } from "./router";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectWithRepos | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [route, navigate] = useRoute();

  async function refreshProjects() {
    const list = await api.listProjects();
    setProjects(list);
    if (route.view === "project" && !route.projectId && list.length > 0) {
      navigate({ projectId: list[0]!.id, tab: "board" });
    }
  }

  async function refreshActive() {
    if (route.view !== "project" || !route.projectId) {
      setActiveProject(null);
      return;
    }
    try {
      const p = await api.getProject(route.projectId);
      setActiveProject(p);
    } catch {
      setActiveProject(null);
      navigate({ projectId: null, ticketId: null });
    }
  }

  useEffect(() => { refreshProjects().catch(console.error); }, []);
  useEffect(() => { refreshActive().catch(console.error); }, [route.view, route.projectId]);

  const isAdmin = route.view === "admin";

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        activeId={route.projectId}
        isAdmin={isAdmin}
        onSelect={(id) => navigate({ view: "project", projectId: id, tab: "board", ticketId: null })}
        onSelectAdmin={() => navigate({ view: "admin", adminSection: "overview" })}
        onCreate={() => setShowCreate(true)}
      />
      <div className="main">
        {isAdmin ? (
          <AdminView route={route} navigate={navigate} />
        ) : activeProject ? (
          <ProjectView
            project={activeProject}
            route={route}
            navigate={navigate}
            onChanged={refreshActive}
            onDeleted={async () => {
              navigate({ projectId: null, ticketId: null });
              await refreshProjects();
            }}
          />
        ) : (
          <div className="empty">
            <p>No project selected.</p>
            <button className="primary" onClick={() => setShowCreate(true)}>
              Create your first project
            </button>
          </div>
        )}
      </div>
      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          onCreated={async (p) => {
            setShowCreate(false);
            await refreshProjects();
            navigate({ view: "project", projectId: p.id, tab: "board", ticketId: null });
          }}
        />
      )}
    </div>
  );
}
