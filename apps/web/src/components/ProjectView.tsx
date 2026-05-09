import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ActiveRunSummary, ProjectWithRepos, Ticket } from "@ceo/shared";
import type { SkillCategory } from "@ceo/shared";
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
// WorkflowEditor pulls in ReactFlow (~150 KB gz). Lazy-load it so users who
// only ever look at the Board tab don't pay for it.
const WorkflowEditor = lazy(() => import("./WorkflowEditor").then((m) => ({ default: m.WorkflowEditor })));
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
  // Fast cadence (2.5s) when something is running; back off to 15s when
  // nothing's active — most projects sit idle most of the time.
  useEffect(() => {
    if (tab !== "board") return;
    let cancelled = false;
    let timer: number | null = null;
    async function tick() {
      try {
        const list = await api.listActiveRuns(project.id);
        if (cancelled) return;
        setActiveRuns(list);
        if (cancelled) return;
        const delay = list.length > 0 ? 2500 : 15000;
        timer = window.setTimeout(tick, delay);
      } catch {
        if (!cancelled) timer = window.setTimeout(tick, 15000);
      }
    }
    tick();
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
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
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "board"}
          className={`tab tab-button ${tab === "board" ? "active" : ""}`}
          onClick={() => setTab("board")}
        >
          {t("tab.board")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "workflow"}
          className={`tab tab-button ${tab === "workflow" ? "active" : ""}`}
          onClick={() => setTab("workflow")}
        >
          {t("tab.playbook")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "memory"}
          className={`tab tab-button ${tab === "memory" ? "active" : ""}`}
          onClick={() => setTab("memory")}
        >
          {t("tab.memory")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "settings"}
          className={`tab tab-button ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          {t("tab.settings")}
        </button>
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
            <CategoryLanes project={project} activeRuns={activeRuns} tickets={tickets} onCardClick={setOpenTicket} />
            <Kanban
              tickets={tickets}
              activeRuns={activeRuns}
              onCardClick={setOpenTicket}
            />
          </>
        )}
        {/* "agents" route still parses for back-compat with old bookmarks; show the unified Playbook editor instead. */}
        {(tab === "workflow" || tab === "agents") && (
          <Suspense fallback={<div style={{ color: "var(--text-dim)", padding: 20 }}>{t("common.loading")}</div>}>
            <WorkflowEditor project={project} tickets={tickets} onChanged={onChanged} />
          </Suspense>
        )}
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
 * CategoryLanes — strip of mini-cards above the Kanban, one per
 * SkillCategory that has at least one skill. Each card shows the active
 * runs whose currently-dispatched agent's skill falls in that category
 * (e.g. "AGA-12 — PHP Senior is in Coding"). Idle categories show a count
 * of resident skills so the user always sees the project's capability
 * surface.
 *
 * Replaces the dropped TeamBoards strip; the Teams concept was redundant
 * with SkillCategory.
 */
function CategoryLanes({
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
  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);
  // Map agent id → SkillCategory based on the phase that uses that agent.
  // Falls back to deriveSkillCategory when no phase explicitly references it.
  const phasesByAgentId = useMemo(() => {
    const m = new Map<string, SkillCategory>();
    for (const p of project.workflow.phases) {
      if (p.kind && p.kind !== "agent") continue;
      if (!p.agent_id) continue;
      const a = project.agents.find((x) => x.id === p.agent_id);
      const cat: SkillCategory = (p.category as SkillCategory | undefined)
        ?? (a ? deriveAgentCategory(a) : "general");
      m.set(p.agent_id, cat);
    }
    return m;
  }, [project.workflow.phases, project.agents]);

  // Categories that actually have skills in this project (don't render empty
  // lanes for capabilities the user never set up).
  const populatedCategories = useMemo(() => {
    const cats = new Set<SkillCategory>();
    for (const c of phasesByAgentId.values()) cats.add(c);
    return SKILL_CATEGORY_ORDER.filter((c) => cats.has(c));
  }, [phasesByAgentId]);

  // Group active runs by the category their current agent belongs to.
  const runsByCategory = useMemo(() => {
    const out = new Map<SkillCategory, ActiveRunSummary[]>();
    for (const r of activeRuns) {
      const agent = project.agents.find((a) => a.name === r.current_agent_name);
      const cat: SkillCategory = (agent && phasesByAgentId.get(agent.id)) ?? "general";
      if (!out.has(cat)) out.set(cat, []);
      out.get(cat)!.push(r);
    }
    return out;
  }, [activeRuns, project.agents, phasesByAgentId]);

  // Skill count per category — rendered as the lane subhead.
  const skillCountByCategory = useMemo(() => {
    const out = new Map<SkillCategory, number>();
    for (const c of phasesByAgentId.values()) out.set(c, (out.get(c) ?? 0) + 1);
    return out;
  }, [phasesByAgentId]);

  if (populatedCategories.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "8px 0 12px", marginBottom: 6 }}>
      {populatedCategories.map((cat) => {
        const runs = runsByCategory.get(cat) ?? [];
        const isActive = runs.length > 0;
        const accent = `var(--cat-${cat})`;
        return (
          <div
            key={cat}
            style={{
              flex: "0 0 220px",
              minHeight: 96,
              border: `1px solid ${isActive ? accent : "var(--border)"}`,
              borderRadius: 8,
              background: isActive ? `color-mix(in srgb, ${accent} 6%, transparent)` : "var(--bg-elev)",
              padding: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <b style={{ fontSize: 12, color: accent }}>{SKILL_CATEGORY_LABEL[cat]}</b>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {skillCountByCategory.get(cat) ?? 0} skill{skillCountByCategory.get(cat) === 1 ? "" : "s"}
              </span>
            </div>
            {!isActive && (
              <div style={{ color: "var(--text-dim)", fontSize: 11, fontStyle: "italic" }}>{t("common.idle")}</div>
            )}
            {runs.map((r) => {
              const ticket = ticketById.get(r.ticket_id);
              return (
                <button
                  key={r.run_id}
                  type="button"
                  onClick={() => ticket && onCardClick(ticket)}
                  disabled={!ticket}
                  style={{
                    fontSize: 11, padding: "4px 6px", marginBottom: 4,
                    background: "var(--bg)", borderRadius: 4,
                    border: "1px solid var(--border)",
                    cursor: ticket ? "pointer" : "default",
                    display: "flex", alignItems: "center", gap: 6,
                    width: "100%", textAlign: "left",
                    font: "inherit", color: "inherit",
                  }}
                  title={`${r.current_agent_name ?? r.agent_role} · ${r.ticket_title}`}
                >
                  <span style={{
                    display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                    background: accent, animation: "pulse 1.4s ease-out infinite",
                  }} />
                  <span style={{ fontWeight: 600, color: accent }}>{r.ticket_key ?? r.ticket_id.slice(0, 6)}</span>
                  <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.ticket_title.slice(0, 32)}{r.ticket_title.length > 32 ? "…" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Quick category derivation for an agent without a phase context — same
 *  rules as the shared deriveSkillCategory but on the agent shape. */
function deriveAgentCategory(a: { name: string; role: string }): SkillCategory {
  const n = a.name.toLowerCase();
  if (n.includes("closer")) return "closing";
  if (n.includes("devops")) return "infra";
  if (n.includes("tech lead") || n.includes("architect") || n.includes("cto")) return "planning";
  if (n.includes("lint")) return "review";
  if (a.role === "reviewer") return "review";
  if (a.role === "tester") return "validation";
  if (a.role === "coder") return "coding";
  return "general";
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

  const derived = useMemo(() => {
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
    return { succeeded, failed, cancelled, running, successRate, cap, capPct, fmtRuntime };
  }, [stats, project.daily_cost_cap_usd]);
  if (!stats || !derived) return null;
  const { succeeded, failed, cancelled, running, successRate, cap, capPct, fmtRuntime } = derived;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 10, marginBottom: 12,
    }}>
      <StatTile
        icon="💰"
        label={t("stats.total_spent")}
        value={`$${stats.total_cost_usd.toFixed(2)}`}
        sub={`${t("stats.today")} $${stats.today_cost_usd.toFixed(2)}${cap ? ` / ${t("stats.cap")} $${cap}` : ""}`}
        accent="#7c3aed"
        progress={capPct}
      />
      <StatTile
        icon="📊"
        label={t("stats.avg_per_run")}
        value={`$${stats.avg_cost_per_run_usd.toFixed(2)}`}
        sub={`${t("stats.runs", { count: stats.runs_total })} · ${t("stats.last_7d")} $${stats.last_7_days_cost_usd.toFixed(2)}`}
        accent="#0ea5e9"
      />
      <StatTile
        icon="🎫"
        label={t("stats.tickets")}
        value={`${stats.tickets_total}`}
        sub={Object.entries(stats.tickets_by_status)
          .map(([s, n]) => `${n} ${t(`board.col.${s}`)}`)
          .join(" · ")}
        accent="#10b981"
      />
      <StatTile
        icon="✓"
        label={t("stats.success_rate")}
        value={`${successRate}%`}
        sub={`${succeeded}✓ ${failed}✗ ${cancelled}⊘${running ? ` · ${t("stats.running", { count: running })}` : ""}`}
        accent={successRate >= 80 ? "#10b981" : successRate >= 50 ? "#d29922" : "#dc2626"}
      />
      <StatTile
        icon="⏱"
        label={t("stats.runtime")}
        value={fmtRuntime}
        sub={t(stats.runs_total === 1 ? "stats.runtime_sub" : "stats.runtime_sub_plural", { count: stats.runs_total })}
        accent="#6b7280"
      />
      <StatTile
        icon="🚀"
        label={t("stats.saved")}
        value={`~${stats.estimated_saved_hours}h`}
        sub={t("stats.saved_sub")}
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
