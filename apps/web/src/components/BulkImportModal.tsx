import { useState } from "react";
import type { ProjectWithRepos } from "@ceo/shared";
import { api } from "../api";
import { useEscClose } from "../hooks";

interface Props {
  project: ProjectWithRepos;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

const PLACEHOLDER = `Paste a markdown list of tickets. Two formats supported:

## Add /orders endpoint
GET /orders?status=active
Pagination 50/page.

## Add /products endpoint
List products with category filter.

— or —

- Add /orders endpoint
- Add /products endpoint
- Fix auth bug
`;

export function BulkImportModal({ project, onClose, onCreated }: Props) {
  useEscClose(onClose);
  const [markdown, setMarkdown] = useState("");
  const [autoTriage, setAutoTriage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; triaged: number } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api.bulkImport(project.id, { markdown, auto_triage: autoTriage });
      setResult({ created: r.created.length, triaged: r.triaged });
      await onCreated();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function extractFromSpec() {
    if (!markdown.trim()) return;
    setExtracting(true);
    setErr(null);
    try {
      const r = await api.extractTicketsFromSpec(project.id, markdown);
      setMarkdown(r.markdown);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" role="dialog" aria-modal="true" style={{ width: 720 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Bulk import</h3>
        <div className="form-row">
          <label>Markdown</label>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={PLACEHOLDER}
            rows={14}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, padding: "8px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>
            Máš volný spec (zadani.md, brain dump…)? Klikni a CTO ti ho rozdělí na tickety v správném formátu — pak si je nahoře zreviewuješ a importneš.
          </span>
          <button
            type="button"
            onClick={extractFromSpec}
            disabled={busy || extracting || !markdown.trim()}
            style={{ fontSize: 11, padding: "4px 10px" }}
          >
            {extracting ? "Rozkládám…" : "↻ Rozložit spec na tickety"}
          </button>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={autoTriage}
            onChange={(e) => setAutoTriage(e.target.checked)}
            style={{ width: "auto" }}
          />
          Auto-triage all tickets after import
        </label>
        {result && (
          <div style={{ color: "var(--green)", fontSize: 12, marginTop: 12 }}>
            Imported {result.created} ticket(s){autoTriage ? `, triaged ${result.triaged}` : ""}.
          </div>
        )}
        {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 12 }}>{err}</div>}
        <div className="form-actions">
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
          <button type="submit" className="primary" disabled={busy || !markdown.trim()}>
            {busy ? "Importing..." : "Import"}
          </button>
        </div>
      </form>
    </div>
  );
}
