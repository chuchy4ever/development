/**
 * Scheduled jobs admin — list / create / edit / delete / run-now.
 *
 * Conceptually: every job is a (trigger, action) pair.
 *   trigger: cron (fires on schedule) | watch (polls connector for new items)
 *   action:  create_ticket | telegram_digest | scheduler_mode
 *
 * The editor splits these into two tabs:
 *   - Akce      = what to do  (action picker + payload)
 *   - Spouštění = when / how  (trigger picker + cron / watch query + active)
 */

import { useEffect, useMemo, useState } from "react";
import type {
  Project,
  ScheduledJob,
  ScheduledJobAction,
  ScheduledJobActionType,
  ScheduledJobTrigger,
  ScheduledJobTriggerType,
  CreateScheduledJobInput,
} from "@ceo/shared";
import { api } from "../api";
import { JobActivityFeed } from "./JobActivityFeed";

interface Props {
  projects: Project[];
  /** When set, scope the list and editor to this project (project-tab variant).
   *  When undefined, show all jobs across projects (admin variant). */
  projectId?: string;
}

export function JobsAdmin({ projects, projectId }: Props) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ScheduledJob | "new" | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function refresh() {
    try {
      const all = await api.listJobs();
      setJobs(projectId ? all.filter((j) => j.project_id === projectId) : all);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { refresh().catch(console.error); }, [projectId]);

  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 4000);
    return () => clearTimeout(t);
  }, [info]);

  async function del(id: string, name: string) {
    if (!confirm(`Smazat job "${name}"?`)) return;
    setBusy(true);
    try { await api.deleteJob(id); await refresh(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function toggle(j: ScheduledJob) {
    setBusy(true);
    try { await api.updateJob(j.id, { enabled: !j.enabled }); await refresh(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function runNow(j: ScheduledJob) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.runJobNow(j.id);
      if (r.ok) setInfo(`✅ ${j.name}: ${r.result}`);
      else setErr(`${j.name}: ${r.result}`);
      await refresh();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <h3 style={{ margin: "0 0 4px" }}>Plánované úlohy</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Každý job = <b>spouštění</b> + <b>akce</b>. Spouštění může být <i>cron</i> (pevný čas)
        nebo <i>watch</i> (poll GitHub/Jira přes project secrets a vystřelí akci na nové záznamy).
        Akce: vytvořit ticket, push digest do Telegramu, toggle scheduleru.
      </p>
      {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {info && <div style={{ color: "var(--green)", fontSize: 12, marginBottom: 8 }}>{info}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {jobs.map((j) => (
          <JobRow
            key={j.id}
            job={j}
            project={projects.find((p) => p.id === j.project_id)}
            projects={projects}
            busy={busy}
            onRunNow={() => runNow(j)}
            onToggle={() => toggle(j)}
            onEdit={() => setEditing(j)}
            onDelete={() => del(j.id, j.name)}
          />
        ))}
        {/* Click-anywhere "+ Nový job" tile. In empty state it's the only row,
            with prose; otherwise it's a compact tile under the list. */}
        <button
          onClick={() => setEditing("new")}
          disabled={busy}
          style={{
            padding: jobs.length === 0 ? 32 : 14,
            border: "1px dashed var(--border)",
            background: "transparent",
            borderRadius: 6,
            color: "var(--text-dim)",
            fontSize: 13,
            cursor: "pointer",
            textAlign: "center",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-dim)"; }}
        >
          {jobs.length === 0 ? <><b>+ Nový job</b><div style={{ fontSize: 11, marginTop: 4 }}>Klikni kamkoli pro výběr typu (GitHub / Jira / Telegram / cron …)</div></> : <b>+ Nový job</b>}
        </button>
      </div>

      {/* Activity feed below the job list. Project-scoped automatically; in
          admin (no projectId) it shows runs from all projects + global. */}
      <JobActivityFeed projectId={projectId} projects={projects} />

      {editing && (
        <JobEditor
          job={editing === "new" ? null : editing}
          projects={projects}
          defaultProjectId={projectId ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
        />
      )}
    </div>
  );
}

function JobRow({
  job, project, projects, busy, onRunNow, onToggle, onEdit, onDelete,
}: {
  job: ScheduledJob;
  project: Project | undefined;
  /** Full project list for resolving fan-out ids → key_prefix labels. */
  projects: Project[];
  busy: boolean;
  onRunNow: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const next = job.next_run_at ? new Date(job.next_run_at) : null;
  const last = job.last_run_at ? new Date(job.last_run_at) : null;
  const triggerLabel = job.trigger.type === "cron"
    ? job.trigger.schedule
    : `watch ${job.trigger.source} · ${job.trigger.poll_schedule}`;
  const recent = job.recent_results ?? [];
  const latest = recent[0];
  return (
    <div style={{
      background: "var(--bg)",
      border: `1px solid ${job.enabled ? "var(--border)" : "var(--gray-soft)"}`,
      borderRadius: 6, fontSize: 13,
      opacity: job.enabled ? 1 : 0.6,
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 220px 200px 200px auto",
        gap: 12, alignItems: "center",
        padding: "10px 12px",
      }}>
        <div>
          <div style={{ fontWeight: 600 }}>{job.name}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            <span style={{ background: "var(--gray-soft)", padding: "1px 6px", borderRadius: 4, marginRight: 6, fontFamily: "ui-monospace, monospace" }}>{job.action.type}</span>
            {(() => {
              // Resolve scope to a single user-visible label. N=1 fan-out and
              // legacy single-project_id render identically — same mental model.
              const fan = job.fan_out_project_ids ?? [];
              const ids = fan.length > 0 ? fan : (job.project_id ? [job.project_id] : []);
              if (ids.length === 0) return <span style={{ fontStyle: "italic" }}>výchozí</span>;
              if (ids.length === 1) {
                const p = projects.find((x) => x.id === ids[0]);
                return p
                  ? <span>{p.key_prefix} ({p.name})</span>
                  : <span>{ids[0]!.slice(0, 6)}</span>;
              }
              const labels = ids
                .map((id) => projects.find((p) => p.id === id)?.key_prefix ?? id.slice(0, 6))
                .join(", ");
              return <span title={labels}>{ids.length} projektů: {labels.length > 40 ? labels.slice(0, 40) + "…" : labels}</span>;
            })()}
          </div>
        </div>
        <code style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={triggerLabel}>{triggerLabel}</code>
        <div style={{ fontSize: 11 }}>
          <div style={{ color: "var(--text-dim)" }}>příští:</div>
          <div>{next ? next.toLocaleString() : "—"}</div>
        </div>
        <div style={{ fontSize: 11 }}>
          <div style={{ color: "var(--text-dim)" }}>poslední:</div>
          <div>{last ? last.toLocaleString() : "—"}</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onRunNow} disabled={busy} title="Spustit teď (ignoruje plán)">▶</button>
          <button onClick={onToggle} disabled={busy} title={job.enabled ? "Pozastavit" : "Aktivovat"}>
            {job.enabled ? "⏸" : "▶▶"}
          </button>
          <button onClick={onEdit} disabled={busy}>Upravit</button>
          <button onClick={onDelete} disabled={busy} className="danger">×</button>
        </div>
      </div>
      {latest && (
        <div style={{
          padding: "6px 12px",
          borderTop: "1px solid var(--gray-soft)",
          fontSize: 11,
          color: "var(--text-dim)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={latest.summary}>
            <b style={{ color: "var(--text)" }}>Nejnovější:</b>
            {latest.project_id && (
              <span style={{ marginLeft: 4, padding: "1px 5px", borderRadius: 3, background: "var(--gray-soft)", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>
                {projects.find((p) => p.id === latest.project_id)?.key_prefix ?? latest.project_id.slice(0, 6)}
              </span>
            )}
            {" "}{latest.summary}
          </span>
          {latest.url && (
            <a href={latest.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>otevřít ↗</a>
          )}
          {recent.length > 1 && (
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              style={{ fontSize: 10, padding: "1px 8px" }}
            >
              {historyOpen ? "skrýt historii" : `${recent.length - 1} starší`}
            </button>
          )}
        </div>
      )}
      {historyOpen && recent.length > 1 && (
        <div style={{ padding: "4px 12px 8px", borderTop: "1px solid var(--gray-soft)" }}>
          {recent.slice(1).map((r, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--text-dim)", padding: "3px 0", display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ minWidth: 130, color: "var(--text-muted)" }}>{new Date(r.at).toLocaleString()}</span>
              {r.project_id && (
                <span style={{ padding: "1px 5px", borderRadius: 3, background: "var(--gray-soft)", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>
                  {projects.find((p) => p.id === r.project_id)?.key_prefix ?? r.project_id.slice(0, 6)}
                </span>
              )}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.summary}>{r.summary}</span>
              {r.url && <a href={r.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>↗</a>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Editor modal ----------------------------------------------------------

const ACTION_LABELS: Record<ScheduledJobActionType, string> = {
  create_ticket: "Vytvořit ticket",
  review_pr: "Code review PR (Reviewer → komentář na GitHubu)",
  telegram_digest: "Push digest stats do Telegramu",
  telegram_message: "Pošli Telegram zprávu",
  scheduler_mode: "Toggle backlog scheduler (running/paused)",
  webhook: "HTTP webhook (Slack / Discord / cokoli)",
  github_op: "GitHub operace (komentář / label / assign / dispatch …)",
};

function defaultActionFor(type: ScheduledJobActionType): ScheduledJobAction {
  if (type === "create_ticket") {
    return { type: "create_ticket", title: "{watch_title}", body: "{watch_url}\n\n{watch_body}", priority: "P2", auto_start: false };
  }
  if (type === "review_pr") return { type: "review_pr", post_comment: true };
  if (type === "telegram_digest") return { type: "telegram_digest", lookback_hours: 24 };
  if (type === "telegram_message") return { type: "telegram_message", text: "🔔 {watch_title}\n{watch_url}" };
  if (type === "webhook") {
    return {
      type: "webhook",
      url: "https://hooks.slack.com/services/...",
      method: "POST",
      body_template: '{"text":"🔔 {watch_title}\\n{watch_url}"}',
    };
  }
  if (type === "github_op") {
    return {
      type: "github_op",
      github: { op: "issue_comment", repo: "{watch_repo}", issue_number: "{watch_id}", body: "Hi {watch_user}, …" },
    };
  }
  return { type: "scheduler_mode", mode: "running" };
}

function defaultTriggerFor(type: ScheduledJobTriggerType): ScheduledJobTrigger {
  if (type === "cron") return { type: "cron", schedule: "0 9 * * 1" };
  return { type: "watch", source: "github", query: "is:pr review-requested:@me", poll_schedule: "*/5 * * * *" };
}

// ---- Connector presets ------------------------------------------------------

/**
 * Job presets — one per connector / source. The wizard (step 1) shows these
 * as cards; clicking applies the trigger + default action and opens the form
 * (step 2). Inside the form the user can switch between actions ALLOWED for
 * that connector (e.g. GitHub watch: review_pr OR create_ticket), but not
 * across connectors — for that, use "← Zpět na výběr".
 *
 * Scope (global vs project) follows the parent context: jobs created from
 * Admin → Plánované úlohy default to global; jobs from Project → Plánované
 * úlohy default to that project. No scope picker per preset.
 */
interface JobPreset {
  id: string;
  icon: string;
  iconBg: string;
  title: string;
  description: string;
  /** Initial trigger applied when preset is picked. */
  trigger: ScheduledJobTrigger;
  /** Default action applied when preset is picked. */
  action: ScheduledJobAction;
  /** Action types the user may switch to within this preset's form.
   *  Always includes preset.action.type as the first entry. */
  allowed_actions: ScheduledJobActionType[];
  defaultName: string;
}

const PRESETS: JobPreset[] = [
  {
    id: "github",
    icon: "GH",
    iconBg: "#24292f",
    title: "GitHub",
    description: "Sleduje GitHub Search query (defaultně review-requested PRs). V dalším kroku zvolíš co se má stát: inline code review (Reviewer agent → review s inline komentáři) nebo vytvoření ticketu v inboxu.",
    trigger: { type: "watch", source: "github", query: "is:pr is:open review-requested:@me", poll_schedule: "*/15 * * * *" },
    action: { type: "review_pr", post_comment: true, focus_mode: "comprehensive" },
    allowed_actions: ["review_pr", "create_ticket", "github_op", "webhook", "telegram_message"],
    defaultName: "GitHub: review-requested PRs",
  },
  {
    id: "github-stale",
    icon: "GH",
    iconBg: "#6b7280",
    title: "GitHub: stale PR připomínka",
    description: "Sleduje PRs bez aktivity X dní a pošle připomínku do PR komentáře (github_op).",
    trigger: { type: "watch", source: "github", query: "is:pr is:open updated:<2026-04-01", poll_schedule: "0 9 * * 1-5" },
    action: {
      type: "github_op",
      github: { op: "issue_comment", repo: "{watch_repo}", issue_number: "{watch_number}", body: "👋 Tento PR je tichý — můžeš ho posunout dál, nebo zavřít?" },
    },
    allowed_actions: ["github_op", "create_ticket", "webhook"],
    defaultName: "GitHub: stale PR reminder",
  },
  {
    id: "github-dispatch",
    icon: "▶",
    iconBg: "#16a34a",
    title: "Cron → GitHub dispatch",
    description: "Cron spustí workflow_dispatch v repu (např. noční build, regenerace caches).",
    trigger: { type: "cron", schedule: "0 2 * * *" },
    action: {
      type: "github_op",
      github: { op: "dispatch_workflow", repo: "owner/repo", workflow_id: "nightly.yml", ref: "main" },
    },
    allowed_actions: ["github_op", "webhook", "telegram_message"],
    defaultName: "Cron: nightly workflow dispatch",
  },
  {
    id: "jira",
    icon: "JR",
    iconBg: "#0052cc",
    title: "Jira",
    description: "Sleduje Jira přes JQL. Na nové issue vytvoří ticket. Auth: project secrets jira_base_url + jira_email + jira_api_token.",
    trigger: { type: "watch", source: "jira", query: "assignee = currentUser() AND status = 'To Do'", poll_schedule: "*/15 * * * *" },
    action: {
      type: "create_ticket",
      title: "Jira: {watch_title}",
      body: "{watch_url}\n\nStatus: {watch_status}\nAssignee: {watch_assignee}",
      priority: "P2",
      auto_start: false,
    },
    allowed_actions: ["create_ticket", "webhook", "telegram_message"],
    defaultName: "Jira: nové issues",
  },
  {
    id: "telegram",
    icon: "✈",
    iconBg: "#0ea5e9",
    title: "Telegram",
    description: "Cron job: na pevně daný čas pošle stats digest (runy, náklady, aktivní tickety) do Telegramu. Default 9:00 každý den.",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    action: { type: "telegram_digest", lookback_hours: 24 },
    allowed_actions: ["telegram_digest", "telegram_message"],
    defaultName: "Telegram: ranní digest",
  },
  {
    id: "webhook",
    icon: "🪝",
    iconBg: "#0d9488",
    title: "Webhook",
    description: "Pošle libovolný HTTP POST/PUT/PATCH na URL — Slack, Discord, vlastní endpoint. Body je JSON template s {watch_*} proměnnými.",
    trigger: { type: "watch", source: "github", query: "is:pr is:open review-requested:@me", poll_schedule: "*/15 * * * *" },
    action: {
      type: "webhook",
      url: "https://hooks.slack.com/services/...",
      method: "POST",
      content_type: "application/json",
      body_template: '{"text":"Nový PR k review: {watch_title} → {watch_url}"}',
    },
    allowed_actions: ["webhook", "telegram_message", "github_op"],
    defaultName: "Webhook: Slack alert na nový PR",
  },
  {
    id: "cron",
    icon: "⏰",
    iconBg: "#7c3aed",
    title: "Plánovač",
    description: "Cron job pro vnitřní akce. V dalším kroku zvolíš: vytvoření recurring ticketu (týdenní lint sweep) nebo toggle backlog scheduleru (maintenance window).",
    trigger: { type: "cron", schedule: "0 9 * * 1" },
    action: {
      type: "create_ticket",
      title: "Týdenní úkol",
      body: "Specifikace úkolu...",
      priority: "P2",
      auto_start: false,
    },
    allowed_actions: ["create_ticket", "scheduler_mode", "webhook", "telegram_message", "github_op"],
    defaultName: "Plánovaný úkol",
  },
];

function JobEditor({
  job, projects, defaultProjectId, onClose, onSaved,
}: {
  job: ScheduledJob | null;
  projects: Project[];
  defaultProjectId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Two-step wizard for new jobs:
  //   "picker" → choose connector preset (GitHub watch, Telegram digest, …)
  //   "form"   → edit pre-filled trigger + action with full controls
  // Editing existing jobs skips the picker.
  const [step, setStep] = useState<"picker" | "form">(job ? "form" : "picker");

  const [name, setName] = useState(job?.name ?? "");
  const [actionType, setActionType] = useState<ScheduledJobActionType>(job?.action.type ?? "create_ticket");
  const [action, setAction] = useState<ScheduledJobAction>(job?.action ?? defaultActionFor("create_ticket"));
  const [triggerType, setTriggerType] = useState<ScheduledJobTriggerType>(job?.trigger.type ?? "cron");
  const [trigger, setTrigger] = useState<ScheduledJobTrigger>(job?.trigger ?? defaultTriggerFor("cron"));
  /** Scope of the job — two modes:
   *    "default"  = admin secrets only, no project context (project_id null,
   *                 no fan-out)
   *    "projects" = one or more selected projects (always stored as fan-out;
   *                 N=1 behaves like single-scope for the user)
   *  Legacy single-project jobs (project_id set, no fan_out) load as
   *  "projects" with [project_id] selected — and on save normalize to fan-out. */
  const initialScope: "default" | "projects" = job
    ? ((job.fan_out_project_ids && job.fan_out_project_ids.length > 0) || job.project_id ? "projects" : "default")
    : (defaultProjectId ? "projects" : "default");
  const [scopeKind, setScopeKind] = useState<"default" | "projects">(initialScope);
  const initialProjectIds: string[] = job?.fan_out_project_ids
    ?? (job?.project_id ? [job.project_id] : (defaultProjectId ? [defaultProjectId] : []));
  const [fanOutIds, setFanOutIds] = useState<string[]>(initialProjectIds);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  /** Action types user can switch to in the form. Set by the wizard preset
   *  (limits to "what makes sense for this connector") or defaults to all
   *  when editing an existing job. */
  const [allowedActions, setAllowedActions] = useState<ScheduledJobActionType[]>(
    job ? ([job.action.type] as ScheduledJobActionType[]) : (Object.keys(ACTION_LABELS) as ScheduledJobActionType[]),
  );

  const [preview, setPreview] = useState<{ ok: boolean; nextRun: string | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"action" | "trigger">("action");

  const projectFixed = defaultProjectId !== null;

  function applyPreset(preset: JobPreset) {
    setName(preset.defaultName);
    setActionType(preset.action.type);
    setAction(preset.action);
    setTriggerType(preset.trigger.type);
    setTrigger(preset.trigger);
    setAllowedActions(preset.allowed_actions);
    setStep("form");
  }

  // Reset action / trigger sub-shape when type changes (only on new jobs,
  // and only after picker — applyPreset has already set them).
  useEffect(() => {
    if (job || step === "picker") return;
    setAction((prev) => prev.type === actionType ? prev : defaultActionFor(actionType));
  }, [actionType, job, step]);
  useEffect(() => {
    if (job || step === "picker") return;
    setTrigger((prev) => prev.type === triggerType ? prev : defaultTriggerFor(triggerType));
  }, [triggerType, job, step]);

  // Esc closes.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Live cron preview (debounced) — works for both cron triggers and watch
  // poll_schedules.
  const scheduleForPreview = trigger.type === "cron" ? trigger.schedule : trigger.poll_schedule;
  useEffect(() => {
    if (!scheduleForPreview.trim()) { setPreview(null); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.previewSchedule(scheduleForPreview);
        setPreview({ ok: r.ok, nextRun: r.next_run_at, error: r.error });
      } catch (e: unknown) {
        setPreview({ ok: false, nextRun: null, error: e instanceof Error ? e.message : String(e) });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [scheduleForPreview]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: CreateScheduledJobInput = {
        name,
        // Always normalize to fan_out_project_ids (even N=1) — the backend
        // handles single-project fan-out fine, and this lets the UI use a
        // single multi-select control regardless of project count.
        project_id: null,
        fan_out_project_ids: scopeKind === "projects" ? fanOutIds : undefined,
        trigger,
        action,
        enabled,
      };
      if (job) await api.updateJob(job.id, body);
      else await api.createJob(body);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Validation gate for save.
  const hasAnyProject = scopeKind === "projects" && fanOutIds.length > 0;
  const ticketNeedsProject = action.type === "create_ticket" && !hasAnyProject;
  // review_pr in default scope is fine — token comes from admin secrets and
  // reviewer agent from the global Skill template.
  const watchNeedsProject = trigger.type === "watch" && !hasAnyProject && action.type !== "review_pr";
  const projectsModeEmpty = scopeKind === "projects" && fanOutIds.length === 0;
  const canSave = !busy && name.trim() && scheduleForPreview.trim() && preview?.ok !== false && !ticketNeedsProject && !watchNeedsProject && !projectsModeEmpty;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal" role="dialog" aria-modal="true"
        style={{ width: 640, maxHeight: "90vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>
            {job ? `Upravit: ${job.name}` : step === "picker" ? "Nový job — vyber typ" : "Nový job"}
          </h3>
          <button onClick={onClose} style={{ background: "transparent", border: 0, fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {step === "picker" && (
          <PresetPicker onPick={applyPreset} />
        )}

        {step === "form" && (
          <>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Název (např. Týdenní digest plant-api)"
                style={{ fontWeight: 600 }}
                autoFocus
              />
            </div>

            <div className="phase-modal-tabs" role="tablist" style={{ marginTop: 0 }}>
              <button
                type="button" role="tab" aria-selected={tab === "action"}
                className={`phase-modal-tab ${tab === "action" ? "active" : ""}`}
                onClick={() => setTab("action")}
              >Akce</button>
              <button
                type="button" role="tab" aria-selected={tab === "trigger"}
                className={`phase-modal-tab ${tab === "trigger" ? "active" : ""}`}
                onClick={() => setTab("trigger")}
              >
                Spouštění
                {preview?.ok === false && <span style={{ color: "var(--red)", marginLeft: 4 }}>!</span>}
              </button>
            </div>

            <div style={{ overflow: "auto", paddingRight: 4, marginTop: 12 }}>
              {tab === "action" && (
                <ActionEditor
                  actionType={actionType}
                  action={action}
                  allowedActions={allowedActions}
                  onChangeType={setActionType}
                  onChange={setAction}
                  showProjectHint={ticketNeedsProject && tab === "action"}
                  jobLocked={!!job}
                  isGlobal={scopeKind === "default"}
                />
              )}
              {tab === "trigger" && (
                <TriggerEditor
                  triggerType={triggerType}
                  trigger={trigger}
                  onChangeType={setTriggerType}
                  onChange={setTrigger}
                  preview={preview}
                  jobLocked={!!job}
                  projects={projects}
                  scopeKind={scopeKind}
                  setScopeKind={setScopeKind}
                  fanOutIds={fanOutIds}
                  setFanOutIds={setFanOutIds}
                  showScopePicker={!projectFixed}
                  enabled={enabled}
                  setEnabled={setEnabled}
                  ticketNeedsProject={ticketNeedsProject}
                  watchNeedsProject={watchNeedsProject}
                  projectsModeEmpty={projectsModeEmpty}
                />
              )}
            </div>
          </>
        )}

        {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div className="form-actions">
          {step === "form" && !job && (
            <button onClick={() => setStep("picker")} disabled={busy} style={{ marginRight: "auto" }}>← Zpět na výběr</button>
          )}
          <button onClick={onClose} disabled={busy}>Zrušit</button>
          {step === "form" && (
            <button className="primary" onClick={save} disabled={!canSave}>
              {busy ? "Ukládám…" : job ? "Uložit" : "Vytvořit"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Preset picker (step 1) ------------------------------------------------

function PresetPicker({ onPick }: { onPick: (preset: JobPreset) => void }) {
  return (
    <div style={{ overflow: "auto", paddingRight: 4 }}>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Začni výběrem konektoru / typu úlohy. V dalším kroku doladíš detaily (cron, šablonu ticketu, query, …).
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "12px 14px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          >
            <span style={{
              flexShrink: 0,
              width: 36, height: 36, lineHeight: "36px",
              textAlign: "center", borderRadius: 6,
              background: p.iconBg, color: "white",
              fontSize: 13, fontWeight: 700,
            }}>{p.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{p.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Action sub-editor -----------------------------------------------------

function ActionEditor({
  actionType, action, allowedActions, onChangeType, onChange, showProjectHint, jobLocked, isGlobal,
}: {
  actionType: ScheduledJobActionType;
  action: ScheduledJobAction;
  allowedActions: ScheduledJobActionType[];
  onChangeType: (t: ScheduledJobActionType) => void;
  onChange: (a: ScheduledJobAction) => void;
  showProjectHint: boolean;
  jobLocked: boolean;
  isGlobal: boolean;
}) {
  // Render the picker only when:
  //   - more than one action allowed by the preset (e.g. GitHub: review_pr OR
  //     create_ticket) AND we're creating a new job
  // For edit mode or single-option presets, the type is fixed — show a
  // read-only label instead of a disabled dropdown.
  const canSwitch = allowedActions.length > 1 && !jobLocked;
  return (
    <>
      {canSwitch ? (
        <div className="form-row">
          <label>Druh akce</label>
          <select
            value={actionType}
            onChange={(e) => onChangeType(e.target.value as ScheduledJobActionType)}
          >
            {allowedActions.map((k) => (
              <option key={k} value={k}>{ACTION_LABELS[k]}</option>
            ))}
          </select>
        </div>
      ) : (
        <div className="form-row">
          <label>Druh akce</label>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>{ACTION_LABELS[actionType]}</div>
        </div>
      )}
      {action.type === "create_ticket" && (
        <CreateTicketForm action={action} onChange={onChange} />
      )}
      {action.type === "review_pr" && (
        <ReviewPrForm action={action} onChange={onChange} isGlobal={isGlobal} />
      )}
      {action.type === "telegram_digest" && (
        <TelegramDigestForm action={action} onChange={onChange} />
      )}
      {action.type === "telegram_message" && (
        <TelegramMessageForm action={action} onChange={onChange} />
      )}
      {action.type === "webhook" && (
        <WebhookForm action={action} onChange={onChange} />
      )}
      {action.type === "github_op" && (
        <GithubOpForm action={action} onChange={onChange} />
      )}
      {action.type === "scheduler_mode" && (
        <SchedulerModeForm action={action} onChange={onChange} />
      )}
      {showProjectHint && (
        <div style={{ fontSize: 11, color: "var(--red)", marginTop: 8 }}>
          Vytvořit ticket vyžaduje projekt — vyber ho na záložce Spouštění.
        </div>
      )}
    </>
  );
}

function CreateTicketForm({ action, onChange }: {
  action: Extract<ScheduledJobAction, { type: "create_ticket" }>;
  onChange: (a: ScheduledJobAction) => void;
}) {
  const set = (patch: Partial<typeof action>) => onChange({ ...action, ...patch });
  return (
    <>
      <div className="form-row">
        <label>Titulek ticketu</label>
        <input
          value={action.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Týdenní lint sweep — nebo {watch_title} pro watch joby"
        />
      </div>
      <div className="form-row">
        <label>Popis (markdown)</label>
        <textarea
          value={action.body}
          onChange={(e) => set({ body: e.target.value })}
          rows={6}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          placeholder="Specifikace úkolu, akceptační kritéria, soubory..."
        />
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          Pro watch joby použij placeholdery: <code>{"{watch_title}"}</code>, <code>{"{watch_url}"}</code>, <code>{"{watch_body}"}</code>, <code>{"{watch_user}"}</code> (GitHub) nebo <code>{"{watch_status}"}</code>, <code>{"{watch_assignee}"}</code> (Jira).
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="form-row">
          <label>Priorita</label>
          <select value={action.priority ?? "P2"} onChange={(e) => set({ priority: e.target.value as typeof action.priority })}>
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
            <option value="P3">P3</option>
          </select>
        </div>
        <div className="form-row" style={{ alignSelf: "end" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={!!action.auto_start} onChange={(e) => set({ auto_start: e.target.checked })} />
            Auto-start (Director hned)
          </label>
        </div>
      </div>
    </>
  );
}

function ReviewPrForm({ action, onChange, isGlobal }: {
  action: Extract<ScheduledJobAction, { type: "review_pr" }>;
  onChange: (a: ScheduledJobAction) => void;
  isGlobal: boolean;
}) {
  const set = (patch: Partial<typeof action>) => onChange({ ...action, ...patch });
  return (
    <>
      <div className="form-row">
        <label>Hloubka review</label>
        <select
          value={action.focus_mode ?? "comprehensive"}
          onChange={(e) => set({ focus_mode: e.target.value as typeof action.focus_mode })}
        >
          <option value="comprehensive">comprehensive — všechno (bugy, styl, návrhy)</option>
          <option value="critical_only">critical only — jen funkční bugy, typos, security/perf</option>
        </select>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          {action.focus_mode === "critical_only"
            ? "Vynechá style nits, naming, dokumentační návrhy. Vhodné pro projekty kde chceš jen kritické věci."
            : "Plné review s návrhy zlepšení."}
        </div>
      </div>
      <div className="form-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          id="review-pr-post-comment"
          type="checkbox"
          checked={action.post_comment !== false}
          onChange={(e) => set({ post_comment: e.target.checked })}
        />
        <label htmlFor="review-pr-post-comment" style={{ flex: 1, cursor: "pointer" }}>
          <div>Postnout review na GitHub</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, fontWeight: 400 }}>
            Vypnuté = dry run (review se jen vygeneruje a zaloguje). Užitečné pro testování promptů.
          </div>
        </label>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, padding: 8, background: "var(--gray-soft)", borderRadius: 4 }}>
        <b>Reviewer:</b> {isGlobal
          ? <>šablona <code>reviewer</code> z <b>Admin → Templates → Skill templates</b> (system prompt + model). Token z <b>Admin → Connectors</b>.</>
          : <>první agent s rolí <code>reviewer</code> z tohoto projektu.</>}<br/>
        <b>Jak to funguje:</b> stáhne unified diff přes GitHub API, pošle ho Revieweru, výsledek postne jako proper GitHub review s <b>inline komentáři per řádek</b>. Žádný worktree.
      </div>
    </>
  );
}

function TelegramDigestForm({ action, onChange }: {
  action: Extract<ScheduledJobAction, { type: "telegram_digest" }>;
  onChange: (a: ScheduledJobAction) => void;
}) {
  const set = (patch: Partial<typeof action>) => onChange({ ...action, ...patch });
  return (
    <>
      <div className="form-row">
        <label>Lookback (hodiny)</label>
        <input
          type="number" min={1} max={720}
          value={action.lookback_hours ?? 24}
          onChange={(e) => set({ lookback_hours: Number(e.target.value) })}
        />
      </div>
      <div className="form-row">
        <label>Telegram chat id (volitelné)</label>
        <input
          value={action.chat_id ?? ""}
          onChange={(e) => set({ chat_id: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="(použije se TELEGRAM_OUTPUT_CHAT_ID)"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
        />
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          Pošli botovi <code>/chatid</code> v cílové skupině/kanálu.
        </div>
      </div>
    </>
  );
}

function TelegramMessageForm({ action, onChange }: {
  action: Extract<ScheduledJobAction, { type: "telegram_message" }>;
  onChange: (a: ScheduledJobAction) => void;
}) {
  const set = (patch: Partial<typeof action>) => onChange({ ...action, ...patch });
  return (
    <>
      <div className="form-row">
        <label>Text zprávy</label>
        <textarea
          value={action.text}
          onChange={(e) => set({ text: e.target.value })}
          rows={5}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          placeholder="🔔 Nový PR: {watch_title}&#10;{watch_url}"
        />
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          Placeholdery z watch triggeru: <code>{"{watch_title}"}</code>, <code>{"{watch_url}"}</code>, <code>{"{watch_body}"}</code>, <code>{"{watch_user}"}</code>, <code>{"{watch_repo}"}</code>, <code>{"{watch_id}"}</code>.
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="form-row">
          <label>Chat ID (volitelné)</label>
          <input
            value={action.chat_id ?? ""}
            onChange={(e) => set({ chat_id: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="(použije TELEGRAM_OUTPUT_CHAT_ID)"
          />
        </div>
        <div className="form-row">
          <label>Parse mode</label>
          <select value={action.parse_mode ?? "Markdown"} onChange={(e) => set({ parse_mode: e.target.value as typeof action.parse_mode })}>
            <option value="Markdown">Markdown</option>
            <option value="MarkdownV2">MarkdownV2</option>
            <option value="HTML">HTML</option>
            <option value="">plain text</option>
          </select>
        </div>
      </div>
    </>
  );
}

function WebhookForm({ action, onChange }: {
  action: Extract<ScheduledJobAction, { type: "webhook" }>;
  onChange: (a: ScheduledJobAction) => void;
}) {
  const set = (patch: Partial<typeof action>) => onChange({ ...action, ...patch });
  // Headers as a textarea (one "Key: value" per line) — simpler than a list
  // editor and good enough for typical 0-3 header use cases.
  const headersText = Object.entries(action.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  const setHeadersText = (text: string) => {
    const headers: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (m) headers[m[1]!.trim()] = m[2]!.trim();
    }
    set({ headers: Object.keys(headers).length > 0 ? headers : undefined });
  };
  return (
    <>
      <div className="form-row">
        <label>URL</label>
        <input
          value={action.url}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://hooks.slack.com/services/T.../B.../..."
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8 }}>
        <div className="form-row">
          <label>Method</label>
          <select value={action.method ?? "POST"} onChange={(e) => set({ method: e.target.value as typeof action.method })}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>
        <div className="form-row">
          <label>Content-Type</label>
          <input
            value={action.content_type ?? "application/json"}
            onChange={(e) => set({ content_type: e.target.value })}
          />
        </div>
      </div>
      <div className="form-row">
        <label>Body (template)</label>
        <textarea
          value={action.body_template}
          onChange={(e) => set({ body_template: e.target.value })}
          rows={6}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          placeholder='{"text":"🔔 {watch_title}\n{watch_url}"}'
        />
      </div>
      <div className="form-row">
        <label>Headers (volitelné, jeden řádek = "Key: value")</label>
        <textarea
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={3}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          placeholder="Authorization: Bearer xxx&#10;X-Custom-Header: value"
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6, padding: 8, background: "var(--gray-soft)", borderRadius: 4 }}>
        Placeholdery <code>{"{watch_*}"}</code> v URL i body se rozbalí. Příklady:
        <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
          <li>Slack incoming webhook</li>
          <li>Discord webhook</li>
          <li>n8n / Make / Zapier trigger URL</li>
          <li>vlastní firemní endpoint</li>
        </ul>
      </div>
    </>
  );
}

function GithubOpForm({ action, onChange }: {
  action: Extract<ScheduledJobAction, { type: "github_op" }>;
  onChange: (a: ScheduledJobAction) => void;
}) {
  const op = action.github;
  const setOp = (next: typeof op) => onChange({ ...action, github: next });

  function changeOpType(newOp: typeof op.op) {
    // Switch to the new op shape with sensible defaults — keep repo across.
    const repo = ("repo" in op) ? op.repo : "{watch_repo}";
    if (newOp === "issue_comment") setOp({ op: "issue_comment", repo, issue_number: "{watch_id}", body: "Hi {watch_user}, …" });
    else if (newOp === "set_labels") setOp({ op: "set_labels", repo, issue_number: "{watch_id}", labels: ["needs-review"] });
    else if (newOp === "close_issue") setOp({ op: "close_issue", repo, issue_number: "{watch_id}" });
    else if (newOp === "assign") setOp({ op: "assign", repo, issue_number: "{watch_id}", assignees: ["chuchy4ever"] });
    else if (newOp === "request_reviewers") setOp({ op: "request_reviewers", repo, pr_number: "{watch_id}", reviewers: ["chuchy4ever"] });
    else setOp({ op: "dispatch_workflow", repo, workflow_id: "ci.yml", ref: "main" });
  }

  return (
    <>
      <div className="form-row">
        <label>Operace</label>
        <select value={op.op} onChange={(e) => changeOpType(e.target.value as typeof op.op)}>
          <option value="issue_comment">Komentář na issue / PR</option>
          <option value="set_labels">Nastavit labely (přepíše stávající)</option>
          <option value="close_issue">Zavřít issue / PR</option>
          <option value="assign">Přiřadit assignees</option>
          <option value="request_reviewers">Vyžádat reviewery</option>
          <option value="dispatch_workflow">Spustit GitHub Actions workflow</option>
        </select>
      </div>
      <div className="form-row">
        <label>Repo (owner/name)</label>
        <input
          value={op.repo}
          onChange={(e) => setOp({ ...op, repo: e.target.value } as typeof op)}
          placeholder="{watch_repo} (z watch triggeru) nebo owner/name napevno"
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        />
      </div>

      {("issue_number" in op || "pr_number" in op) && (
        <div className="form-row">
          <label>{op.op === "request_reviewers" ? "PR number" : "Issue / PR number"}</label>
          <input
            value={op.op === "request_reviewers" ? op.pr_number : op.issue_number}
            onChange={(e) => {
              const v = e.target.value;
              if (op.op === "request_reviewers") setOp({ ...op, pr_number: v });
              else setOp({ ...op, issue_number: v } as typeof op);
            }}
            placeholder="{watch_id} nebo konkrétní číslo"
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          />
        </div>
      )}

      {op.op === "issue_comment" && (
        <div className="form-row">
          <label>Tělo komentáře</label>
          <textarea
            value={op.body}
            onChange={(e) => setOp({ ...op, body: e.target.value })}
            rows={4}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            placeholder="Hi {watch_user}, this PR has been idle…"
          />
        </div>
      )}

      {op.op === "set_labels" && (
        <div className="form-row">
          <label>Labely (čárkami)</label>
          <input
            value={op.labels.join(", ")}
            onChange={(e) => setOp({ ...op, labels: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            placeholder="needs-review, ready-to-merge"
          />
        </div>
      )}

      {op.op === "assign" && (
        <div className="form-row">
          <label>Assignees (GitHub usernames, čárkami)</label>
          <input
            value={op.assignees.join(", ")}
            onChange={(e) => setOp({ ...op, assignees: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            placeholder="chuchy4ever, alice"
          />
        </div>
      )}

      {op.op === "request_reviewers" && (
        <>
          <div className="form-row">
            <label>Reviewers (usernames, čárkami)</label>
            <input
              value={op.reviewers.join(", ")}
              onChange={(e) => setOp({ ...op, reviewers: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              placeholder="chuchy4ever, alice"
            />
          </div>
          <div className="form-row">
            <label>Team reviewers (slugs, volitelné)</label>
            <input
              value={(op.team_reviewers ?? []).join(", ")}
              onChange={(e) => {
                const teams = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                setOp({ ...op, team_reviewers: teams.length > 0 ? teams : undefined });
              }}
              placeholder="frontend-team, security"
            />
          </div>
        </>
      )}

      {op.op === "dispatch_workflow" && (
        <>
          <div className="form-row">
            <label>Workflow file (název nebo ID)</label>
            <input
              value={op.workflow_id}
              onChange={(e) => setOp({ ...op, workflow_id: e.target.value })}
              placeholder="ci.yml"
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>Ref (větev / tag)</label>
            <input
              value={op.ref ?? "main"}
              onChange={(e) => setOp({ ...op, ref: e.target.value })}
              placeholder="main"
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>Inputs (volitelné, JSON)</label>
            <textarea
              value={op.inputs ? JSON.stringify(op.inputs, null, 2) : ""}
              onChange={(e) => {
                try {
                  const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
                  setOp({ ...op, inputs: parsed });
                } catch { /* keep typing — we'll save once it parses */ }
              }}
              rows={3}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
              placeholder='{"environment":"staging"}'
            />
          </div>
        </>
      )}

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6, padding: 8, background: "var(--gray-soft)", borderRadius: 4 }}>
        Auth: project secret <code>github_token</code> (nebo výchozí). Stejný token jako pro watch / review_pr.
      </div>
    </>
  );
}

function SchedulerModeForm({ action, onChange }: {
  action: Extract<ScheduledJobAction, { type: "scheduler_mode" }>;
  onChange: (a: ScheduledJobAction) => void;
}) {
  return (
    <div className="form-row">
      <label>Režim</label>
      <select value={action.mode} onChange={(e) => onChange({ ...action, mode: e.target.value as typeof action.mode })}>
        <option value="running">running (scheduler aktivní)</option>
        <option value="paused">paused (scheduler pozastavený)</option>
      </select>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
        Spáruj dva joby (např. 02:00 → running, 06:00 → paused) pro údržbové okno.
      </div>
    </div>
  );
}

// ---- Trigger sub-editor ----------------------------------------------------

function TriggerEditor({
  triggerType, trigger, onChangeType, onChange, preview, jobLocked,
  projects, scopeKind, setScopeKind, fanOutIds, setFanOutIds,
  showScopePicker, enabled, setEnabled, ticketNeedsProject, watchNeedsProject, projectsModeEmpty,
}: {
  triggerType: ScheduledJobTriggerType;
  trigger: ScheduledJobTrigger;
  onChangeType: (t: ScheduledJobTriggerType) => void;
  onChange: (t: ScheduledJobTrigger) => void;
  preview: { ok: boolean; nextRun: string | null; error?: string } | null;
  jobLocked: boolean;
  projects: Project[];
  scopeKind: "default" | "projects";
  setScopeKind: (k: "default" | "projects") => void;
  fanOutIds: string[];
  setFanOutIds: (ids: string[]) => void;
  showScopePicker: boolean;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  ticketNeedsProject: boolean;
  watchNeedsProject: boolean;
  projectsModeEmpty: boolean;
}) {
  return (
    <>
      {/* Trigger type is fixed by the wizard preset. Render as a read-only
          label rather than a disabled dropdown — disabled selects are visual
          noise that imply "you could change this if not for some reason."
          The "← Zpět na výběr" footer already gives the change path. */}
      <div className="form-row">
        <label>Spouštěč</label>
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
          {triggerType === "cron"
            ? <>cron — pevný plán (čas)</>
            : <>watch — sleduj GitHub/Jira a vystřel na nové záznamy</>}
        </div>
      </div>

      {trigger.type === "cron" && (
        <CronTriggerForm trigger={trigger} onChange={onChange} preview={preview} />
      )}
      {trigger.type === "watch" && (
        <WatchTriggerForm trigger={trigger} onChange={onChange} preview={preview} watchNeedsProject={watchNeedsProject} />
      )}

      {showScopePicker && (
        <ScopePicker
          scopeKind={scopeKind}
          setScopeKind={setScopeKind}
          fanOutIds={fanOutIds}
          setFanOutIds={setFanOutIds}
          projects={projects}
          ticketNeedsProject={ticketNeedsProject}
          watchNeedsProject={watchNeedsProject}
          projectsModeEmpty={projectsModeEmpty}
        />
      )}

      <div className="form-row">
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Aktivní
        </label>
      </div>
    </>
  );
}

/** Two-mode scope picker: default (admin secrets, no project) or projects
 *  (one or more selected — N=1 acts like single-scope from the user's POV).
 *  Backend always receives fan_out_project_ids in projects mode regardless
 *  of count; that's an implementation detail the UI hides. */
function ScopePicker({
  scopeKind, setScopeKind, fanOutIds, setFanOutIds,
  projects, ticketNeedsProject, watchNeedsProject, projectsModeEmpty,
}: {
  scopeKind: "default" | "projects";
  setScopeKind: (k: "default" | "projects") => void;
  fanOutIds: string[];
  setFanOutIds: (ids: string[]) => void;
  projects: Project[];
  ticketNeedsProject: boolean;
  watchNeedsProject: boolean;
  projectsModeEmpty: boolean;
}) {
  const toggleFan = (id: string) => {
    if (fanOutIds.includes(id)) setFanOutIds(fanOutIds.filter((x) => x !== id));
    else setFanOutIds([...fanOutIds, id]);
  };
  // Wrapped in a div (not form-row > label) — the form-row's label CSS
  // applies text-transform: uppercase, and we don't want that cascading
  // into the radio descriptions.
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 8 }}>
        Pro koho job běží
      </div>

      {/* Two tabs side-by-side. Active = accent border + bg, click anywhere
          to select. Picking "Projekty" with one item checked = formerly
          "single project"; we just expose one mental model. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <ScopeTab
          active={scopeKind === "default"}
          onClick={() => setScopeKind("default")}
          title="Výchozí"
          desc={<>Admin secrets, žádný projektový kontext. Pro jeden globální běh.</>}
        />
        <ScopeTab
          active={scopeKind === "projects"}
          onClick={() => setScopeKind("projects")}
          title="Projekty"
          desc={<>Vyber jeden nebo víc. Job poběží pro každý nezávisle (vlastní state, secrets, akce).</>}
        />
      </div>

      {/* Project multi-select — visible only when "Projekty" mode active. */}
      {scopeKind === "projects" && (
        <div style={{ marginTop: 10, padding: 8, background: "var(--gray-soft)", borderRadius: 4, maxHeight: 180, overflow: "auto" }}>
          {projects.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Žádné projekty.</div>
          ) : projects.map((p) => (
            <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 0", cursor: "pointer", textTransform: "none" }}>
              <input
                type="checkbox"
                checked={fanOutIds.includes(p.id)}
                onChange={() => toggleFan(p.id)}
              />
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-dim)", minWidth: 50 }}>{p.key_prefix}</span>
              <span style={{ flex: 1 }}>{p.name}</span>
            </label>
          ))}
        </div>
      )}

      {ticketNeedsProject && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>Vytvořit ticket potřebuje aspoň jeden projekt.</div>}
      {watchNeedsProject && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>Watch trigger potřebuje projekt (Jira watch nelze v default scope).</div>}
      {projectsModeEmpty && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>Vyber aspoň jeden projekt.</div>}
    </div>
  );
}

/** One of the three scope tabs. Clickable card; active state shows accent
 *  border + subtle bg. Visually compact — title + one line of description. */
function ScopeTab({ active, onClick, title, desc }: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "10px 12px",
        background: active ? "rgba(124, 58, 237, 0.06)" : "var(--bg)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 6,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        textTransform: "none", // counter form-row label cascade
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <span style={{
          display: "inline-block",
          width: 12, height: 12,
          borderRadius: "50%",
          border: `2px solid ${active ? "var(--accent)" : "var(--text-dim)"}`,
          background: active ? "var(--accent)" : "transparent",
          flexShrink: 0,
        }} />
        {title}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

function CronTriggerForm({ trigger, onChange, preview }: {
  trigger: Extract<ScheduledJobTrigger, { type: "cron" }>;
  onChange: (t: ScheduledJobTrigger) => void;
  preview: { ok: boolean; nextRun: string | null; error?: string } | null;
}) {
  return (
    <div className="form-row">
      <label>Plán (cron)</label>
      <input
        value={trigger.schedule}
        onChange={(e) => onChange({ ...trigger, schedule: e.target.value })}
        placeholder="0 9 * * 1   (nebo @once:2026-12-01T09:00:00Z)"
        style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
      />
      <SchedulePreview preview={preview} />
      <CronExamples onPick={(s) => onChange({ ...trigger, schedule: s })} />
    </div>
  );
}

function WatchTriggerForm({ trigger, onChange, preview, watchNeedsProject }: {
  trigger: Extract<ScheduledJobTrigger, { type: "watch" }>;
  onChange: (t: ScheduledJobTrigger) => void;
  preview: { ok: boolean; nextRun: string | null; error?: string } | null;
  watchNeedsProject: boolean;
}) {
  // Source is fixed by the wizard preset (and can't be changed mid-edit
  // because it determines query syntax + auth secrets). User who wants a
  // different connector clicks "← Zpět na výběr" and picks a new preset.
  const isGithub = trigger.source === "github";
  return (
    <>
      <div className="form-row">
        <label>{isGithub ? "GitHub search query" : "JQL (Jira)"}</label>
        <input
          value={trigger.query}
          onChange={(e) => onChange({ ...trigger, query: e.target.value })}
          placeholder={isGithub ? "is:pr review-requested:@me" : "assignee = currentUser() AND status = 'To Do'"}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
        />
        <QueryHelper
          source={isGithub ? "github" : "jira"}
          onPick={(q) => onChange({ ...trigger, query: q })}
        />
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          {isGithub
            ? <>Auth: project secret <code>github_token</code>. Stejná syntax jako vyhledávání na github.com.</>
            : <>Auth: project secrets <code>jira_base_url</code> + <code>jira_email</code> + <code>jira_api_token</code>.</>}
        </div>
      </div>
      <div className="form-row">
        <label>Interval pollu (cron)</label>
        <input
          value={trigger.poll_schedule}
          onChange={(e) => onChange({ ...trigger, poll_schedule: e.target.value })}
          placeholder="*/5 * * * *"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
        />
        <SchedulePreview preview={preview} />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          {[
            { label: "5 min", cron: "*/5 * * * *" },
            { label: "15 min", cron: "*/15 * * * *" },
            { label: "1 hod", cron: "0 * * * *" },
            { label: "Po-Pá 9-17 každou hodinu", cron: "0 9-17 * * 1-5" },
          ].map((ex) => (
            <button
              key={ex.cron}
              type="button"
              onClick={() => onChange({ ...trigger, poll_schedule: ex.cron })}
              style={{ fontSize: 10, padding: "2px 8px" }}
            >{ex.label}</button>
          ))}
        </div>
      </div>
      <div style={{
        fontSize: 11, color: "var(--text-dim)",
        padding: 8, background: "var(--gray-soft)", borderRadius: 4, marginTop: 8,
      }}>
        ℹ Při prvním spuštění watch zaznamená baseline (existující záznamy) a <b>nestřelí akci</b>. Akce se vystřelí jen na záznamy, které se objeví <i>poté</i>.
      </div>
    </>
  );
}

function SchedulePreview({ preview }: { preview: { ok: boolean; nextRun: string | null; error?: string } | null }) {
  if (!preview) return null;
  return (
    <div style={{ fontSize: 11, marginTop: 4, color: preview.ok ? "var(--green)" : "var(--red)" }}>
      {preview.ok
        ? (preview.nextRun
          ? <>✓ příští spuštění: <b>{new Date(preview.nextRun).toLocaleString()}</b></>
          : "✓ syntaxe v pořádku, ale @once datum je v minulosti — nevystřelí se")
        : <>✗ {preview.error}</>}
    </div>
  );
}

/** Cheat-sheet helper for GitHub search / Jira JQL. Two sections:
 *    1. "Příklady" — full queries you can click to substitute.
 *    2. "Operátory" — building blocks (qualifiers / fields). Clicking
 *       APPENDS to the input, so user can compose: pick "is:pr" then
 *       "is:open" then "author:@me" → assembled query.
 *  Collapsed by default — taking too much vertical space otherwise. */
function QueryHelper({ source, onPick }: { source: "github" | "jira"; onPick: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const examples = source === "github" ? GITHUB_QUERY_EXAMPLES : JIRA_QUERY_EXAMPLES;
  const operators = source === "github" ? GITHUB_QUERY_OPERATORS : JIRA_QUERY_OPERATORS;

  return (
    <div style={{ marginTop: 6, fontSize: 11 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 10, padding: "2px 8px", color: "var(--text-dim)" }}
      >
        {open ? "skrýt nápovědu" : "📖 nápověda + příklady"}
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: 8, background: "var(--gray-soft)", borderRadius: 4, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase" }}>Příklady (klik = nahradí)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {examples.map((ex) => (
                <button
                  key={ex.q}
                  type="button"
                  onClick={() => onPick(ex.q)}
                  style={{ textAlign: "left", padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                >
                  <div style={{ color: "var(--text)" }}>{ex.label}</div>
                  <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "ui-monospace, monospace" }}>{ex.q}</code>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase" }}>Operátory & qualifiers</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {operators.map((op) => (
                <code
                  key={op.token}
                  title={op.desc}
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 3,
                    fontFamily: "ui-monospace, monospace",
                    color: "var(--text-dim)",
                  }}
                >{op.token}</code>
              ))}
            </div>
          </div>
          <a
            href={source === "github"
              ? "https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests"
              : "https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/"}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 10, color: "var(--accent)" }}
          >
            Plná dokumentace ↗
          </a>
        </div>
      )}
    </div>
  );
}

const GITHUB_QUERY_EXAMPLES = [
  { label: "Otevřené PRs kde mám review", q: "is:pr is:open review-requested:@me" },
  { label: "Otevřené PRs co jsem napsal", q: "is:pr is:open author:@me" },
  { label: "Otevřené issues přiřazené mně", q: "is:issue is:open assignee:@me" },
  { label: "PRs review-requested v konkrétním repu", q: "is:pr is:open review-requested:@me repo:owner/name" },
  { label: "PRs s labelem (např. ready-to-review)", q: "is:pr is:open label:ready-to-review" },
  { label: "PRs aktualizované za posledních 7 dní", q: "is:pr is:open updated:>=2026-05-03" },
  { label: "Mentions na mě", q: "is:open mentions:@me" },
  { label: "PRs v org že kde jsem člen", q: "is:pr is:open org:my-org review-requested:@me" },
];

const GITHUB_QUERY_OPERATORS = [
  { token: "is:pr", desc: "Pouze PRs" },
  { token: "is:issue", desc: "Pouze issues" },
  { token: "is:open", desc: "Otevřené" },
  { token: "is:closed", desc: "Zavřené" },
  { token: "is:merged", desc: "Mergnuté PRs" },
  { token: "is:draft", desc: "Draft PRs" },
  { token: "draft:false", desc: "Bez draftů" },
  { token: "review-requested:@me", desc: "Já jsem requested reviewer" },
  { token: "reviewed-by:@me", desc: "Už jsem reviewoval" },
  { token: "author:@me", desc: "Já jsem autor" },
  { token: "assignee:@me", desc: "Já jsem assignee" },
  { token: "mentions:@me", desc: "Mention v komentáři/těle" },
  { token: "repo:owner/name", desc: "Konkrétní repo" },
  { token: "org:name", desc: "Všechna repos org" },
  { token: "user:name", desc: "Všechna repos uživatele" },
  { token: "label:bug", desc: "S labelem" },
  { token: "-label:wontfix", desc: "BEZ labelu (minus)" },
  { token: "head:branch-name", desc: "Z konkrétní větve" },
  { token: "base:main", desc: "Mířící do větve" },
  { token: "created:>=2026-01-01", desc: "Vytvořené po datu" },
  { token: "updated:<2026-05-01", desc: "Aktualizované před" },
  { token: "comments:>5", desc: "Více než N komentářů" },
];

const JIRA_QUERY_EXAMPLES = [
  { label: "Moje To Do", q: 'assignee = currentUser() AND status = "To Do"' },
  { label: "Moje aktivní (To Do + In Progress)", q: 'assignee = currentUser() AND status in ("To Do", "In Progress")' },
  { label: "Issues v konkrétním projektu", q: 'project = "PROJ" AND status != Done' },
  { label: "Bugs s vysokou prioritou", q: 'type = Bug AND priority in (Highest, High) AND resolution = Unresolved' },
  { label: "Reportoval jsem", q: "reporter = currentUser() AND resolution = Unresolved" },
  { label: "Aktualizováno za posledních 24h", q: "updated >= -1d" },
  { label: "Vytvořeno tento týden", q: "created >= startOfWeek()" },
  { label: "Bez assignee", q: "assignee is EMPTY AND resolution = Unresolved" },
];

const JIRA_QUERY_OPERATORS = [
  { token: "project = KEY", desc: "Filtrovat na projekt" },
  { token: "assignee = currentUser()", desc: "Já jako řešitel" },
  { token: "reporter = currentUser()", desc: "Já jako reporter" },
  { token: 'status = "To Do"', desc: "Konkrétní status" },
  { token: 'status in (...)', desc: "Více statusů" },
  { token: 'status != Done', desc: "Není status" },
  { token: "type = Bug", desc: "Typ issue" },
  { token: "priority = High", desc: "Priorita" },
  { token: 'labels = "release"', desc: "Štítek" },
  { token: "resolution = Unresolved", desc: "Nevyřešené" },
  { token: "resolution is EMPTY", desc: "Bez resolution" },
  { token: "assignee is EMPTY", desc: "Nepřiřazené" },
  { token: "created >= -7d", desc: "Vytvořeno za N dní" },
  { token: "updated > startOfDay()", desc: "Aktualizováno dnes" },
  { token: 'sprint in openSprints()', desc: "V aktivním sprintu" },
  { token: 'fixVersion = "1.0"', desc: "Konkrétní fix version" },
  { token: 'AND / OR / NOT', desc: "Logické operátory" },
  { token: 'ORDER BY created DESC', desc: "Řazení (volitelné)" },
];

function CronExamples({ onPick }: { onPick: (cron: string) => void }) {
  const examples = useMemo(() => [
    { label: "Po 9:00", cron: "0 9 * * 1" },
    { label: "Každý den 9:00", cron: "0 9 * * *" },
    { label: "Každých 30 min", cron: "*/30 * * * *" },
    { label: "Pá 17:00", cron: "0 17 * * 5" },
  ], []);
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
      {examples.map((ex) => (
        <button
          key={ex.cron}
          type="button"
          onClick={() => onPick(ex.cron)}
          style={{ fontSize: 10, padding: "2px 8px" }}
        >{ex.label}</button>
      ))}
    </div>
  );
}
