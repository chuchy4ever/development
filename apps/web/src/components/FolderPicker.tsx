import { useEffect, useState } from "react";
import { api } from "../api";
import { useEscClose } from "../hooks";

interface Props {
  onPick: (absolutePath: string) => void;
  onClose: () => void;
}

export function FolderPicker({ onPick, onClose }: Props) {
  useEscClose(onClose);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.browseFolder>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  async function load(path?: string) {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.browseFolder(path));
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function createFolder() {
    if (!data || !newFolderName.trim()) return;
    setCreating(true);
    setErr(null);
    try {
      const r = await api.mkdirFolder(data.path, newFolderName.trim());
      setNewFolderName("");
      await load(r.path); // navigate into the new folder
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 640, maxHeight: "80vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Pick a folder</h3>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 10px", background: "var(--bg)",
          border: "1px solid var(--border)", borderRadius: 6,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 12, marginBottom: 12,
        }}>
          <button
            onClick={() => data?.parent && load(data.parent)}
            disabled={!data?.parent || loading}
            style={{ padding: "2px 8px" }}
          >
            ↑
          </button>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {loading ? "Loading…" : data?.path ?? "—"}
          </span>
          {data?.is_git && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 6px",
              background: "var(--green-soft)", color: "#047857", borderRadius: 3,
            }}>git repo</span>
          )}
        </div>

        {/* Create new folder */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="new folder name (e.g. bff)"
            onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
            disabled={creating || !data}
            style={{ flex: 1 }}
          />
          <button
            onClick={createFolder}
            disabled={creating || !newFolderName.trim() || !data}
            title={data ? `Create inside ${data.path}` : ""}
          >
            {creating ? "..." : "+ Create"}
          </button>
        </div>

        {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{err}</div>}

        <div style={{
          flex: 1, overflowY: "auto",
          border: "1px solid var(--border)", borderRadius: 6, marginBottom: 12,
        }}>
          {data?.entries
            .filter((e) => showHidden || !e.is_hidden)
            .map((e) => (
              <div
                key={e.name}
                onClick={() => load(`${data.path === "/" ? "" : data.path}/${e.name}`)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
                onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-soft)")}
                onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
              >
                <span>📁</span>
                <span style={{ flex: 1, color: e.is_hidden ? "var(--text-muted)" : "var(--text)" }}>
                  {e.name}
                </span>
                {e.is_git && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: "1px 5px",
                    background: "var(--green-soft)", color: "#047857", borderRadius: 3,
                  }}>git</span>
                )}
              </div>
            ))}
          {data && data.entries.filter((e) => showHidden || !e.is_hidden).length === 0 && (
            <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
              (empty)
            </div>
          )}
        </div>

        <label style={{
          fontSize: 11, color: "var(--text-dim)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
            style={{ width: "auto" }}
          />
          Show hidden folders (.* )
        </label>

        <div className="form-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => data && onPick(data.path)}
            disabled={!data}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
