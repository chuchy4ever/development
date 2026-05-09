import { useState } from "react";
import type { ProjectWithRepos } from "@ceo/shared";
import { api } from "../api";
import { useEscClose } from "../hooks";

interface Props {
  onClose: () => void;
  onCreated: (p: ProjectWithRepos) => void;
}

export function CreateProjectModal({ onClose, onCreated }: Props) {
  useEscClose(onClose);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createProject({ name: name.trim(), description });
      onCreated(p);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New project</h3>
        <div className="form-row">
          <label>Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ERP integrace"
            autoFocus
          />
        </div>
        <div className="form-row">
          <label>Short description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="BFF + S2S talking to ERP..."
          />
        </div>
        {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
