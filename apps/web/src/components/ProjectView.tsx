import { useEffect, useState } from "react";
import type { ActiveRunSummary, ProjectWithRepos, Ticket } from "@ceo/shared";
import { api } from "../api";
import type { Route, Tab } from "../router";
import { Kanban } from "./Kanban";
import { ProjectSettings } from "./ProjectSettings";
import { InboxForm } from "./InboxForm";
import { TicketModal } from "./TicketModal";
import { SchedulerBar } from "./SchedulerBar";
import { BulkImportModal } from "./BulkImportModal";
import { WorkflowEditor } from "./WorkflowEditor";
import { AgentsView } from "./AgentsView";
import { MemoryView } from "./MemoryView";

interface Props {
  project: ProjectWithRepos;
  route: Route;
  navigate: (next: Partial<Route>) => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

export function ProjectView({ project, route, navigate, onChanged, onDeleted }: Props) {
  const tab = route.tab;
  const setTab = (t: Tab) => navigate({ tab: t, ticketId: null });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRunSummary[]>([]);
  const [showBulk, setShowBulk] = useState(false);
  const openTicket = route.ticketId
    ? tickets.find((t) => t.id === route.ticketId) ?? null
    : null;
  const setOpenTicket = (t: Ticket | null) =>
    navigate({ ticketId: t ? t.id : null });

  async function refreshTickets() {
    const list = await api.listTickets(project.id);
    setTickets(list);
    // openTicket is derived from route + tickets; if the open ticket no longer
    // exists (deleted), clear it from the URL.
    if (route.ticketId && !list.find((t) => t.id === route.ticketId)) {
      navigate({ ticketId: null });
    }
  }

  useEffect(() => {
    refreshTickets().catch(console.error);
  }, [project.id]);

  // Poll tickets while on the Board tab so the kanban reflects status changes
  // (running → done / blocked, new tickets created via decompose, etc.) without
  // a manual refresh. Slower than activeRuns since tickets change less often.
  useEffect(() => {
    if (tab !== "board") return;
    let cancelled = false;
    async function tick() {
      try {
        const list = await api.listTickets(project.id);
        if (!cancelled) setTickets(list);
      } catch {}
    }
    const t = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [project.id, tab]);

  // Poll active runs while on the Board tab so cards show who's working.
  useEffect(() => {
    if (tab !== "board") return;
    let cancelled = false;
    async function tick() {
      try {
        const list = await api.listActiveRuns(project.id);
        if (!cancelled) setActiveRuns(list);
      } catch {}
    }
    tick();
    const t = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [project.id, tab]);

  return (
    <>
      <div className="toolbar">
        <div>
          <h2>{project.name}</h2>
          <div className="meta">
            {project.repos.length} folder{project.repos.length === 1 ? "" : "s"}
            {project.description ? ` · ${project.description}` : ""}
          </div>
        </div>
      </div>
      <div className="tabs">
        <div className={`tab ${tab === "board" ? "active" : ""}`} onClick={() => setTab("board")}>
          Board
        </div>
        <div className={`tab ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>
          Agents
        </div>
        <div className={`tab ${tab === "workflow" ? "active" : ""}`} onClick={() => setTab("workflow")}>
          Workflow
        </div>
        <div className={`tab ${tab === "memory" ? "active" : ""}`} onClick={() => setTab("memory")}>
          Memory
        </div>
        <div className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
          Settings
        </div>
        <div style={{ flex: 1 }} />
        {tab === "board" && (
          <button
            style={{ marginRight: 12, alignSelf: "center" }}
            onClick={() => setShowBulk(true)}
          >
            Bulk import
          </button>
        )}
      </div>
      {tab === "board" && <SchedulerBar />}
      <div className="content">
        {tab === "board" && (
          <>
            <InboxForm
              project={project}
              onCreated={async () => {
                await refreshTickets();
              }}
            />
            <Kanban
              tickets={tickets}
              activeRuns={activeRuns}
              onCardClick={setOpenTicket}
            />
          </>
        )}
        {tab === "agents" && <AgentsView project={project} onChanged={onChanged} />}
        {tab === "workflow" && <WorkflowEditor project={project} tickets={tickets} />}
        {tab === "memory" && <MemoryView project={project} />}
        {tab === "settings" && (
          <ProjectSettings
            project={project}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        )}
      </div>
      {showBulk && (
        <BulkImportModal
          project={project}
          onClose={() => setShowBulk(false)}
          onCreated={refreshTickets}
        />
      )}
      {openTicket && (
        <TicketModal
          ticket={openTicket}
          project={project}
          allTickets={tickets}
          onOpenTicket={setOpenTicket}
          onClose={() => setOpenTicket(null)}
          onChanged={refreshTickets}
        />
      )}
    </>
  );
}
