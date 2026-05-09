import { useEffect, useState } from "react";
import type { SchedulerStatus } from "@ceo/shared";
import { api } from "../api";

export function SchedulerBar() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);

  async function refresh() {
    try {
      setStatus(await api.getScheduler());
    } catch {}
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  if (!status) return null;

  const isRunning = status.mode === "running";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "8px 16px",
      background: "var(--bg-elevated)",
      borderTop: "1px solid var(--border)",
      borderBottom: "1px solid var(--border)",
      fontSize: 12,
    }}>
      <span style={{ fontWeight: 600 }}>Scheduler</span>
      <span style={{
        padding: "1px 8px",
        borderRadius: 3,
        color: "white",
        background: isRunning ? "var(--green)" : "var(--text-dim)",
        fontWeight: 600,
        fontSize: 10,
      }}>
        {status.mode}
      </span>
      <span style={{ color: "var(--text-dim)" }}>
        active: <b style={{ color: "var(--text)" }}>{status.active_runs}</b> / {status.max_concurrent}
      </span>
      <span style={{ color: "var(--text-dim)" }}>
        backlog: <b style={{ color: "var(--text)" }}>{status.queue_depth}</b>
      </span>
      <div style={{ flex: 1 }} />
      <label style={{ color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
        max concurrent:
        <input
          type="number"
          min={1}
          max={10}
          value={status.max_concurrent}
          onChange={async (e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setStatus(await api.setSchedulerCapacity(v));
          }}
          style={{ width: 50, padding: "2px 6px" }}
        />
      </label>
      <button
        onClick={async () => {
          setStatus(await api.setSchedulerMode(isRunning ? "paused" : "running"));
        }}
      >
        {isRunning ? "Pause" : "Resume"}
      </button>
    </div>
  );
}
