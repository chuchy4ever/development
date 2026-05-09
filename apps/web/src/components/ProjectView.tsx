import { useEffect, useState } from "react";
import type { ActiveRunSummary, ProjectWithRepos, Ticket } from "@ceo/shared";
import { SKILL_CATEGORY_LABEL, SKILL_CATEGORY_ORDER } from "@ceo/shared";
import { api } from "../api";
import { t, useLang } from "../i18n";
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
  useLang(); // re-render on language change
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
          {t("tab.board")}
        </div>
        <div className={`tab ${tab === "workflow" ? "active" : ""}`} onClick={() => setTab("workflow")}>
          {t("tab.playbook")}
        </div>
        <div className={`tab ${tab === "memory" ? "active" : ""}`} onClick={() => setTab("memory")}>
          {t("tab.memory")}
        </div>
        <div className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
          {t("tab.settings")}
        </div>
        <div style={{ flex: 1 }} />
        {tab === "board" && (
          <button
            style={{ marginRight: 12, alignSelf: "center" }}
            onClick={() => setShowBulk(true)}
          >
            {t("board.bulk_import")}
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
            <ProjectStats project={project} />
            <TeamBoards project={project} activeRuns={activeRuns} tickets={tickets} onCardClick={setOpenTicket} />
            <Kanban
              tickets={tickets}
              activeRuns={activeRuns}
              onCardClick={setOpenTicket}
            />
          </>
        )}
        {/* "agents" route still parses for back-compat with old bookmarks; show the unified Playbook editor instead. */}
        {(tab === "workflow" || tab === "agents") && <WorkflowEditor project={project} tickets={tickets} onChanged={onChanged} />}
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


/**
 * TeamBoards — strip of mini-boards, one per team, showing the tickets
 * currently being handled by that team (i.e., active runs whose dispatched
 * agent belongs to the team). Sits above the main Kanban for quick "where
 * is the work right now?" awareness.
 */
function TeamBoards({
  project,
  activeRuns,
  tickets,
  onCardClick,
}: {
  project: ProjectWithRepos;
  activeRuns: ActiveRunSummary[];
  tickets: Ticket[];
  onCardClick: (t: Ticket) => void;
}) {
  const teams = project.workflow.teams ?? [];
  if (teams.length === 0) return null;
  // Map agent name → team(s).
  const teamByAgentName = new Map<string, typeof teams>();
  for (const t of teams) {
    for (const n of t.agent_names) {
      const list = teamByAgentName.get(n) ?? [];
      list.push(t);
      teamByAgentName.set(n, list);
    }
  }
  // Group active runs by team.
  const runsByTeam = new Map<string, ActiveRunSummary[]>();
  for (const r of activeRuns) {
    const name = r.current_agent_name ?? "";
    const matched = teamByAgentName.get(name) ?? [];
    for (const tm of matched) {
      const list = runsByTeam.get(tm.id) ?? [];
      list.push(r);
      runsByTeam.set(tm.id, list);
    }
  }
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  // Order teams by SkillCategory canonical order.
  const sortedTeams = [...teams].sort((a, b) => {
    const ai = SKILL_CATEGORY_ORDER.indexOf(a.category ?? "general");
    const bi = SKILL_CATEGORY_ORDER.indexOf(b.category ?? "general");
    return ai - bi;
  });

  return (
    <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "8px 0 12px", marginBottom: 6 }}>
      {sortedTeams.map((team) => {
        const runs = runsByTeam.get(team.id) ?? [];
        const isActive = runs.length > 0;
        return (
          <div
            key={team.id}
            style={{
              flex: "0 0 220px",
              minHeight: 96,
              border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8,
              background: isActive ? "rgba(124, 92, 255, 0.06)" : "var(--bg-elev)",
              padding: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <b style={{ fontSize: 12 }}>{team.name}</b>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {team.category ? SKILL_CATEGORY_LABEL[team.category] : ""}
              </span>
            </div>
            {!isActive && (
              <div style={{ color: "var(--text-dim)", fontSize: 11, fontStyle: "italic" }}>{t("common.idle")}</div>
            )}
            {runs.map((r) => {
              const ticket = ticketById.get(r.ticket_id);
              return (
                <div
                  key={r.run_id}
                  onClick={() => ticket && onCardClick(ticket)}
                  style={{
                    fontSize: 11, padding: "4px 6px", marginBottom: 4,
                    background: "var(--bg)", borderRadius: 4,
                    border: "1px solid var(--border)",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                  title={r.ticket_title}
                >
                  <span style={{
                    display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                    background: "var(--accent)", animation: "pulse 1.4s ease-out infinite",
                  }} />
                  <span style={{ fontWeight: 600, color: "var(--accent)" }}>{r.ticket_key ?? r.ticket_id.slice(0, 6)}</span>
                  <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.ticket_title.slice(0, 32)}{r.ticket_title.length > 32 ? "…" : ""}
                  </span>
                </div>
              );
            })}
            <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>
              {t(team.agent_names.length === 1 ? "teams_strip.members_one" : "teams_strip.members_many", { count: team.agent_names.length })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * ProjectStats — at-a-glance numbers for the Board tab. Polls the
 * /stats endpoint every 15s so the user sees costs add up live.
 *
 * Three groups:
 *  • Money: total spent, today, last 7 days, avg per run
 *  • Throughput: total tickets, runs, success rate, runtime, est. saved
 *  • Status pills (succeeded / failed / cancelled / running)
 *
 * "Estimated saved" is a soft heuristic (1.5h × succeeded runs); labeled
 * as such so the user knows it's not measured.
 */
function ProjectStats({ project }: { project: ProjectWithRepos }) {
  const [stats, setStats] = useState<{
    runs_total: number;
    runs_by_status: Record<string, number>;
    total_cost_usd: number;
    today_cost_usd: number;
    last_7_days_cost_usd: number;
    total_runtime_ms: number;
    avg_cost_per_run_usd: number;
    tickets_by_status: Record<string, number>;
    tickets_total: number;
    estimated_saved_hours: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const s = await api.getProjectStats(project.id);
        if (!cancelled) setStats(s);
      } catch {}
    }
    tick();
    const i = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(i); };
  }, [project.id]);

  if (!stats) return null;

  const succeeded = stats.runs_by_status.succeeded ?? 0;
  const failed = stats.runs_by_status.failed ?? 0;
  const cancelled = stats.runs_by_status.cancelled ?? 0;
  const running = stats.runs_by_status.running ?? 0;
  const successRate = stats.runs_total > 0
    ? Math.round((succeeded / stats.runs_total) * 100)
    : 0;
  const cap = project.daily_cost_cap_usd;
  const capPct = cap && cap > 0 ? Math.min(100, Math.round((stats.today_cost_usd / cap) * 100)) : null;

  const runtimeHours = stats.total_runtime_ms / 3_600_000;
  const fmtRuntime = runtimeHours >= 1
    ? `${runtimeHours.toFixed(1)}h`
    : `${Math.round(stats.total_runtime_ms / 60000)}m`;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 10, marginBottom: 12,
    }}>
      <StatTile
        icon="💰"
        label="Total spent"
        value={`$${stats.total_cost_usd.toFixed(2)}`}
        sub={`today $${stats.today_cost_usd.toFixed(2)}${cap ? ` / cap $${cap}` : ""}`}
        accent="#7c3aed"
        progress={capPct}
      />
      <StatTile
        icon="📊"
        label="Avg per run"
        value={`$${stats.avg_cost_per_run_usd.toFixed(2)}`}
        sub={`${stats.runs_total} runs · last 7d $${stats.last_7_days_cost_usd.toFixed(2)}`}
        accent="#0ea5e9"
      />
      <StatTile
        icon="🎫"
        label="Tickets"
        value={`${stats.tickets_total}`}
        sub={Object.entries(stats.tickets_by_status)
          .map(([s, n]) => `${n} ${s}`)
          .join(" · ")}
        accent="#10b981"
      />
      <StatTile
        icon="✓"
        label="Success rate"
        value={`${successRate}%`}
        sub={`${succeeded}✓ ${failed}✗ ${cancelled}⊘${running ? ` · ${running} running` : ""}`}
        accent={successRate >= 80 ? "#10b981" : successRate >= 50 ? "#d29922" : "#dc2626"}
      />
      <StatTile
        icon="⏱"
        label="Total runtime"
        value={fmtRuntime}
        sub={`across ${stats.runs_total} run${stats.runs_total === 1 ? "" : "s"}`}
        accent="#6b7280"
      />
      <StatTile
        icon="🚀"
        label="Est. dev time saved"
        value={`~${stats.estimated_saved_hours}h`}
        sub="1.5h × successful runs (rough)"
        accent="#ec4899"
      />
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  sub,
  accent,
  progress,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
  accent: string;
  progress?: number | null;
}) {
  return (
    <div style={{
      padding: 12,
      border: "1px solid var(--border)",
      borderRadius: 8,
      background: "var(--bg-elev)",
      borderLeft: `3px solid ${accent}`,
      position: "relative",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        <span>{icon}</span>
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent, marginTop: 2, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>{sub}</div>
      )}
      {typeof progress === "number" && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: 3,
          background: "var(--gray-soft)", borderRadius: "0 0 8px 8px", overflow: "hidden",
        }}>
          <div style={{
            width: `${progress}%`, height: "100%",
            background: progress >= 80 ? "#dc2626" : accent,
          }} />
        </div>
      )}
    </div>
  );
}
