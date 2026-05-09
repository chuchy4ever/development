import { useState } from "react";
import type { ProjectWithRepos } from "@ceo/shared";
import { api } from "../api";

interface Props {
  project: ProjectWithRepos;
  onCreated: () => Promise<void>;
}

export function InboxForm({ project, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoTriage, setAutoTriage] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const ticket = await api.createTicket(project.id, { title: title.trim(), body });
      setTitle("");
      setBody("");
      await onCreated();
      if (autoTriage) {
        try {
          await api.triageTicket(project.id, ticket.id);
          await onCreated();
        } catch (e: any) {
          setErr(`Triage failed: ${e.message}. Ticket stays in Inbox.`);
        }
      }
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inbox-form" onSubmit={submit}>
      <div className="form-row">
        <label>New ticket — title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Add /orders endpoint with status filter"
        />
      </div>
      <div className="form-row">
        <label>Body (optional, free text)</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Background, acceptance criteria, links to ERP docs..."
          rows={3}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={autoTriage}
            onChange={(e) => setAutoTriage(e.target.checked)}
            style={{ width: "auto" }}
          />
          Auto-triage on submit
        </label>
        <button type="submit" className="primary" disabled={busy || !title.trim()}>
          {busy ? "Submitting..." : "Add to Inbox"}
        </button>
      </div>
      {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </form>
  );
}
