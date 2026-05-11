/**
 * Floating notification bell — top-right corner of the app. Polls the
 * server every 30s for "notable" job_runs since the user's last-seen
 * timestamp (stored in localStorage, single-user app).
 *
 * Click → dropdown with the 10 most recent notable items + a "Mark all read"
 * button that bumps the last-seen timestamp.
 */

import { useEffect, useRef, useState } from "react";
import type { JobRun, Project } from "@ceo/shared";
import { api } from "../api";

const LAST_SEEN_KEY = "ceo.notifications.lastSeenAt";
const POLL_MS = 30_000;

function loadLastSeen(): string {
  // Default to "1 day ago" on first load so we don't show 30 days of history.
  return localStorage.getItem(LAST_SEEN_KEY) ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

function saveLastSeen(iso: string) {
  localStorage.setItem(LAST_SEEN_KEY, iso);
}

export function NotificationsBell({ projects }: { projects: Project[] }) {
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<JobRun[]>([]);
  const [open, setOpen] = useState(false);
  const lastSeenRef = useRef(loadLastSeen());
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Poll unread count.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await api.unreadJobRunsCount(lastSeenRef.current);
        if (!cancelled) setUnread(r.count);
      } catch { /* silent — bell shouldn't crash UI */ }
    }
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Load latest notable items when the dropdown opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.listJobRuns({ notable: true, limit: 10 })
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function markAllRead() {
    const now = new Date().toISOString();
    saveLastSeen(now);
    lastSeenRef.current = now;
    setUnread(0);
  }

  return (
    <div ref={popoverRef} style={{ position: "fixed", top: 12, right: 16, zIndex: 1000 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "relative",
          background: unread > 0 ? "var(--accent)" : "var(--bg-elevated, var(--bg))",
          color: unread > 0 ? "white" : "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 18,
          padding: "6px 14px",
          fontSize: 14,
          cursor: "pointer",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title={unread > 0 ? `${unread} nových` : "Žádné nové notifikace"}
      >
        <span>🔔</span>
        {unread > 0 && (
          <span style={{
            background: "white",
            color: "var(--accent)",
            borderRadius: 10,
            padding: "0 6px",
            fontSize: 11,
            fontWeight: 700,
            minWidth: 18,
            textAlign: "center",
          }}>{unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          right: 0,
          marginTop: 6,
          width: 460,
          maxHeight: 500,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          display: "flex",
          flexDirection: "column",
        }}>
          <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Nedávná aktivita</span>
            <div style={{ flex: 1 }} />
            {unread > 0 && (
              <button onClick={markAllRead} style={{ fontSize: 11, padding: "3px 8px" }}>Označit jako přečtené</button>
            )}
          </div>
          <div style={{ overflow: "auto", maxHeight: 440 }}>
            {items.length === 0 ? (
              <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
                Žádné notable události.
              </div>
            ) : items.map((r) => (
              <NotificationRow key={r.id} run={r} projects={projects} lastSeen={lastSeenRef.current} />
            ))}
          </div>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
            Plný log → <a href="#/admin/jobruns" style={{ color: "var(--accent)" }}>Admin → Logs</a>
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({ run, projects, lastSeen }: { run: JobRun; projects: Project[]; lastSeen: string }) {
  const isUnread = run.fired_at > lastSeen;
  const projectLabel = run.project_id
    ? (projects.find((p) => p.id === run.project_id)?.key_prefix ?? run.project_id.slice(0, 6))
    : "výchozí";
  return (
    <div style={{
      padding: "8px 12px",
      borderBottom: "1px solid var(--gray-soft)",
      background: isUnread ? "rgba(124, 58, 237, 0.04)" : "transparent",
      fontSize: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ color: run.ok ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{run.ok ? "✓" : "✗"}</span>
        <span style={{
          fontFamily: "ui-monospace, monospace", fontSize: 10,
          padding: "1px 5px", borderRadius: 3,
          background: "var(--gray-soft)", color: "var(--text-dim)",
        }}>{projectLabel}</span>
        <span style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={run.job_name}>{run.job_name}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{relativeTime(run.fired_at)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ flex: 1, color: "var(--text)" }} title={run.summary}>{run.summary.slice(0, 200)}</span>
        {run.url && (
          <a href={run.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 11, whiteSpace: "nowrap" }}>otevřít ↗</a>
        )}
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
