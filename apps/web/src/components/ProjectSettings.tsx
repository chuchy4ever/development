import { useState } from "react";
import type { ProjectWithRepos } from "@ceo/shared";
import { api } from "../api";
import { FolderPicker } from "./FolderPicker";
import { ConnectorSecretsPanel } from "./ConnectorSecretsPanel";

interface Props {
  project: ProjectWithRepos;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

export function ProjectSettings({ project, onChanged, onDeleted }: Props) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [specMd, setSpecMd] = useState(project.spec_md);
  const [techStackMd, setTechStackMd] = useState(project.tech_stack_md);
  const [dailyCap, setDailyCap] = useState<string>(
    project.daily_cost_cap_usd != null ? String(project.daily_cost_cap_usd) : "",
  );

  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function saveProject() {
    setBusy(true);
    setErr(null);
    try {
      const capParsed = dailyCap.trim() === "" ? null : Number(dailyCap);
      await api.updateProject(project.id, {
        name,
        description,
        spec_md: specMd,
        tech_stack_md: techStackMd,
        daily_cost_cap_usd: Number.isFinite(capParsed as number) ? (capParsed as number) : null,
      });
      await onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addRepo() {
    if (!repoName.trim() || !repoUrl.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addRepo(project.id, { name: repoName.trim(), url: repoUrl.trim() });
      setRepoName("");
      setRepoUrl("");
      await onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeRepo(repoId: string) {
    if (!confirm("Remove this folder from project? (folder on disk is kept untouched)")) return;
    setBusy(true);
    try {
      await api.removeRepo(project.id, repoId);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      await onDeleted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 800 }}>
      <div className="settings-section">
        <h3>General</h3>
        <div className="form-row">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Spec (markdown) — high-level scope, given to every agent as context</label>
          <textarea
            value={specMd}
            onChange={(e) => setSpecMd(e.target.value)}
            rows={6}
            placeholder="What this project is, who uses it, key constraints..."
          />
        </div>
        <div className="form-row">
          <label>Tech stack (markdown) — conventions, libraries, patterns</label>
          <textarea
            value={techStackMd}
            onChange={(e) => setTechStackMd(e.target.value)}
            rows={4}
            placeholder="Node 20, TypeScript, Fastify, Prisma..."
          />
        </div>
        <div className="form-row">
          <label>Daily cost cap (USD) — empty = no cap</label>
          <input
            type="number"
            min="0"
            step="0.10"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
            placeholder="e.g. 5.00"
          />
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Scheduler skips new runs once today's spend on this project hits the cap; an in-flight
            run aborts at the next phase boundary if it exceeds it.
          </div>
        </div>
        <div className="form-actions">
          <button className="primary" onClick={saveProject} disabled={busy}>
            Save changes
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Project folders</h3>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
          One or more folders that agents will work in. Each must be a git repo (auto-init if not).
        </div>
        <div className="repo-list">
          {project.repos.length === 0 && (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No folders yet.</div>
          )}
          {project.repos.map((r) => (
            <div key={r.id} className="repo-item">
              <div className="info">
                <div className="name">{r.name} <span style={{ color: "var(--text-dim)", fontSize: 11 }}>({r.default_branch})</span></div>
                <div className="url">{r.url}</div>
                <div className="url" style={{ fontSize: 10 }}>→ {r.local_path}</div>
              </div>
              <button className="danger" onClick={() => removeRepo(r.id)} disabled={busy}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto auto", gap: 8 }}>
            <input
              placeholder="short name (e.g. bff, frontend)"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
            />
            <input
              placeholder="pick a folder, or paste git URL / path"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <button onClick={() => setShowPicker(true)} disabled={busy} title="Browse local folders">
              📁 Browse…
            </button>
            <button className="primary" onClick={addRepo} disabled={busy || !repoName.trim() || !repoUrl.trim()}>
              {busy ? "..." : repoUrl.trim().startsWith("/") || repoUrl.trim().startsWith("~") ? "Add folder" : "Clone"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
            Folder path on your machine (preferred for existing projects), or a git URL to clone fresh.
            If the folder isn't a git repo yet, <code>git init</code> runs automatically.
          </div>
        </div>
      </div>

      <ConnectorSecretsPanel scope={{ scope: "project", projectId: project.id }} />

      {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{err}</div>}

      <div className="settings-section" style={{ borderColor: "var(--red)" }}>
        <h3 style={{ color: "var(--red)" }}>Danger zone</h3>
        <button className="danger" onClick={deleteProject} disabled={busy}>
          Delete project
        </button>
      </div>

      {showPicker && (
        <FolderPicker
          onClose={() => setShowPicker(false)}
          onPick={(p) => {
            setRepoUrl(p);
            // Default the short name to the folder's basename if user hasn't typed one.
            if (!repoName.trim()) {
              const base = p.replace(/\/+$/, "").split("/").pop() ?? "";
              if (base) setRepoName(base);
            }
            setShowPicker(false);
          }}
        />
      )}
    </div>
  );
}

