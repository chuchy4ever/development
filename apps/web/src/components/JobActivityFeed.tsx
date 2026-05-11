/**
 * Persistent log of scheduled-job action invocations. Loaded from /api/job-runs.
 *
 * Two scopes:
 *   - { projectId: string }   → scoped to that project (used in Project tab)
 *   - { projectId: undefined } → all projects + global (used in Admin tab)
 *
 * Filters: status (ok/error/all), only-notable (errors + notify-tagged),
 * since (last 24h / 7d / all). The list is read-only; clicking a row's URL
 * opens the external artefact (review on GitHub, ticket, …).
 */

import { useEffect, useMemo, useState } from "react";
import type { JobRun, Project, ScheduledJob } from "@ceo/shared";
import { api } from "../api";

interface Props {
  /** Project scope. undefined = admin (all projects + global). string = project. */
  projectId?: string;
  /** Project list for resolving project_id → key_prefix labels. */
  projects: Project[];
}

type StatusFilter = "all" | "ok" | "error";
type SinceFilter = "1h" | "24h" | "7d" | "all";

const SINCE_HOURS: Record<SinceFilter, number | null> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "all": null,
};

export function JobActivityFeed({ projectId, projects }: Props) {
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sinceFilter, setSinceFilter] = useState<SinceFilter>("7d");
  const [jobFilter, setJobFilter] = useState<string>(""); // job_id or ""
  const [notableOnly, setNotableOnly] = useState(false);

  // Load jobs once for the dropdown filter.
  useEffect(() => {
    api.listJobs(projectId === undefined ? {} : { project_id: projectId }).then(setJobs).catch(() => {});
  }, [projectId]);

  // Compute the `since` ISO from the dropdown.
  const sinceIso = useMemo(() => {
    const hours = SINCE_HOURS[sinceFilter];
    if (hours == null) return undefined;
    return new Date(Date.now() - hours * 3600 * 1000).toISOString();
  }, [sinceFilter]);

  // Refresh runs whenever filters or scope changes. Single closure used for
  // both the initial load and the 15s auto-refresh — keeps args in one place.
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setRuns(null); // show loading state while filters change
    const fetchRuns = async () => {
      try {
        const rows = await api.listJobRuns({
          project_id: projectId,
          job_id: jobFilter || undefined,
          since: sinceIso,
          ok: statusFilter === "all" ? undefined : statusFilter === "ok",
          notable: notableOnly || undefined,
          limit: 200,
        });
        if (!cancelled) setRuns(rows);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchRuns();
    const t = setInterval(() => { void fetchRuns(); }, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectId, jobFilter, sinceIso, statusFilter, notableOnly]);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, marginRight: "auto" }}>Aktivita</h3>

        <select value={sinceFilter} onChange={(e) => setSinceFilter(e.target.value as SinceFilter)} style={{ fontSize: 12 }}>
          <option value="1h">poslední hodina</option>
          <option value="24h">posledních 24h</option>
          <option value="7d">posledních 7 dní</option>
          <option value="all">vše</option>
        </select>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} style={{ fontSize: 12 }}>
          <option value="all">vše</option>
          <option value="ok">jen OK</option>
          <option value="error">jen chyby</option>
        </select>

        {jobs.length > 0 && (
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ fontSize: 12, maxWidth: 200 }}>
            <option value="">všechny joby</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.name}</option>
            ))}
          </select>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-dim)" }}>
          <input type="checkbox" checked={notableOnly} onChange={(e) => setNotableOnly(e.target.checked)} />
          jen notable
        </label>
      </div>

      {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {runs === null ? (
        <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 12 }}>Loading…</div>
      ) : runs.length === 0 ? (
        <div style={{ color: "var(--text-dim)", fontSize: 13, padding: 16, textAlign: "center", border: "1px solid var(--border)", borderRadius: 6 }}>
          Žádná aktivita pro tyto filtry.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {runs.map((r) => (
            <JobRunRow key={r.id} run={r} projects={projects} showProject={projectId === undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRunRow({ run, projects, showProject }: { run: JobRun; projects: Project[]; showProject: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<unknown>(run.details);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const ts = new Date(run.fired_at);
  const projectLabel = run.project_id
    ? (projects.find((p) => p.id === run.project_id)?.key_prefix ?? run.project_id.slice(0, 6))
    : "výchozí";
  const statusIcon = run.ok ? "✓" : "✗";
  const statusColor = run.ok ? "var(--green)" : "var(--red)";
  const hasDetails = !!run.has_details || !!details;

  // Lazy-load the details blob the first time the row is expanded — the list
  // endpoint omits it to keep payloads small (16KB per row × 200 rows would
  // dominate the wire on a 15s auto-refresh).
  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !details && run.has_details) {
      setLoadingDetails(true);
      try {
        const full = await api.getJobRun(run.id);
        setDetails(full.details);
      } catch { /* leave undefined; ReviewDetails handles missing */ }
      finally { setLoadingDetails(false); }
    }
  }
  return (
    <div style={{
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: 4,
    }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: showProject ? "20px 130px 80px 1fr 200px auto auto" : "20px 130px 1fr 200px auto auto",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          fontSize: 12,
          cursor: hasDetails ? "pointer" : "default",
        }}
        onClick={hasDetails ? toggle : undefined}
      >
        <span style={{ color: statusColor, fontWeight: 700, fontSize: 14 }} title={run.ok ? "ok" : "chyba"}>{statusIcon}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }} title={ts.toLocaleString()}>{ts.toLocaleTimeString()}<span style={{ color: "var(--text-dim)", marginLeft: 4 }}>{ts.toLocaleDateString()}</span></span>
        {showProject && (
          <span style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 3,
            background: "var(--gray-soft)",
            color: "var(--text-dim)",
            textAlign: "center",
          }}>{projectLabel}</span>
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={run.summary}>{run.summary}</span>
        <span style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={run.job_name}>{run.job_name}</span>
        {hasDetails ? (
          <button
            onClick={(e) => { e.stopPropagation(); toggle(); }}
            style={{ fontSize: 10, padding: "2px 8px" }}
          >{loadingDetails ? "..." : expanded ? "skrýt" : "detail"}</button>
        ) : <span />}
        {run.url ? (
          <a href={run.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 11 }} onClick={(e) => e.stopPropagation()}>otevřít ↗</a>
        ) : (
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>
        )}
      </div>
      {expanded && hasDetails && <ReviewDetails details={details} />}
    </div>
  );
}

/** Render a review_pr details payload — inline comments grouped per file.
 *  Schema is just `comments[]` now (no summary, no verdict). Falls back to
 *  raw JSON dump for legacy / unknown payloads. */
function ReviewDetails({ details }: { details: unknown }) {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const review = d.review as { comments?: Array<{ path?: string; line?: number; severity?: string; body?: string; side?: string }> } | undefined;

  if (!review) {
    return (
      <pre style={{ fontSize: 11, padding: 12, background: "var(--gray-soft)", borderTop: "1px solid var(--border)", margin: 0, overflow: "auto" }}>
        {JSON.stringify(details, null, 2)}
      </pre>
    );
  }

  const sevBadge: Record<string, { color: string; label: string }> = {
    blocker: { color: "#dc2626", label: "blocker" },
    major: { color: "#ea580c", label: "major" },
    minor: { color: "#ca8a04", label: "minor" },
  };

  // Group comments by file path for a tighter visual.
  const byFile = new Map<string, typeof review.comments>();
  for (const c of review.comments ?? []) {
    const key = c.path ?? "(unknown)";
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(c);
  }

  const repoPr = d.repo && d.pr ? `${d.repo}#${d.pr}` : null;
  const mode = String(d.mode ?? "");
  const totalComments = review.comments?.length ?? 0;

  return (
    <div style={{ padding: "10px 14px", background: "var(--bg-soft, #fafafa)", borderTop: "1px solid var(--gray-soft)", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          <b>{totalComments}</b> {totalComments === 1 ? "komentář" : totalComments < 5 ? "komentáře" : "komentářů"}
        </span>
        {repoPr && <code style={{ fontSize: 11, color: "var(--text-dim)" }}>{repoPr}</code>}
        {mode === "dry_run" && <span style={{ fontSize: 10, color: "var(--text-dim)", padding: "1px 6px", border: "1px dashed var(--border)", borderRadius: 3 }}>dry run</span>}
        {mode === "no_comments" && <span style={{ fontSize: 10, color: "var(--green)" }}>bez připomínek</span>}
      </div>
      {byFile.size > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[...byFile.entries()].map(([path, comments]) => (
            <div key={path}>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, fontWeight: 600, marginBottom: 4, color: "var(--text-dim)" }}>{path}</div>
              {(comments ?? []).map((c, i) => {
                const sb = sevBadge[String(c.severity ?? "minor")] ?? sevBadge.minor!;
                return (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, padding: 8, background: "white", border: "1px solid var(--border)", borderRadius: 4 }}>
                    <span style={{ fontSize: 10, color: sb.color, fontWeight: 700, minWidth: 50 }}>{sb.label}</span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", minWidth: 40, fontFamily: "ui-monospace, monospace" }}>:{c.line ?? "?"}</span>
                    <span style={{ flex: 1, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{c.body}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: "var(--text-dim)", fontSize: 12 }}>Reviewer nenašel nic k vytknutí.</div>
      )}
    </div>
  );
}
