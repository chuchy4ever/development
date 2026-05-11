import { useEffect, useState } from "react";
import type { ProjectWithRepos } from "@ceo/shared";
import { api, type ProjectSecretMasked } from "../api";
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

  /** Defaults available to copy. Loaded from /api/admin/secrets — empty list
   *  if no defaults are configured (then this section is hidden entirely). */
  const [defaults, setDefaults] = useState<ProjectSecretMasked[]>([]);
  const [copyKeys, setCopyKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.listGlobalSecrets().then((rows) => {
      const set = rows.filter((r) => r.has_project_value); // only "really set" defaults
      setDefaults(set);
      // Pre-check all by default — user opts OUT of items they don't want.
      setCopyKeys(new Set(set.map((r) => r.key)));
    }).catch(() => { /* defaults endpoint failure is non-fatal for project create */ });
  }, []);

  function toggleKey(key: string) {
    setCopyKeys((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createProject({ name: name.trim(), description });

      // Copy selected defaults from admin → project_secrets. Done client-side
      // by reading defaults' display values (which include masked tokens that
      // we can't actually copy), so we just call a server endpoint per key
      // that does the copy server-side without exposing values.
      // For now, fire a "copy" PUT per key — the server reads global_secrets
      // and writes project_secrets atomically.
      if (copyKeys.size > 0) {
        await Promise.all(
          Array.from(copyKeys).map((key) =>
            api.copyDefaultSecretToProject(p.id, key).catch((e) => {
              console.warn(`Failed to copy default secret ${key}:`, e);
            }),
          ),
        );
      }

      onCreated(p);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Group defaults by connector for display.
  const defaultGroups: { title: string; prefix: string }[] = [
    { title: "GitHub", prefix: "github_" },
    { title: "Jira", prefix: "jira_" },
    { title: "SSH", prefix: "ssh_" },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <h3>Nový projekt</h3>
        <div style={{ overflow: "auto", paddingRight: 4 }}>
          <div className="form-row">
            <label>Název</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ERP integrace"
              autoFocus
            />
          </div>
          <div className="form-row">
            <label>Krátký popis (volitelné)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="BFF + S2S talking to ERP..."
            />
          </div>

          {defaults.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 4 }}>
                Zkopírovat výchozí connector secrets?
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
                Zaškrtnuté = zkopíruje se a lze pak měnit per-projekt. Odškrtnuté = projekt dědí přes fallback.
              </div>
              {defaultGroups.map((g) => {
                const rows = defaults.filter((d) => d.key.startsWith(g.prefix));
                if (rows.length === 0) return null;
                return (
                  <div key={g.prefix} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>{g.title}</div>
                    {rows.map((r) => (
                      <label
                        key={r.key}
                        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0", cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          checked={copyKeys.has(r.key)}
                          onChange={() => toggleKey(r.key)}
                        />
                        <span style={{ flex: 1 }}>{r.label}</span>
                        <code style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>{r.display}</code>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Zrušit</button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? "Vytváří se…" : "Vytvořit"}
          </button>
        </div>
      </form>
    </div>
  );
}
