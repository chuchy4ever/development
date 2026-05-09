import { useEffect, useState } from "react";
import type { ProjectWithRepos } from "@ceo/shared";
import { api } from "../api";

interface Props {
  project: ProjectWithRepos;
}

const PLACEHOLDER = `Long-lived knowledge for this project. Loaded into every agent's context (via CLAUDE.md at run root) on each run. Examples:

- Auth tokens are validated by middleware in src/auth/. Never bypass it.
- Database column names are snake_case; Eloquent models map to camelCase via $casts.
- Tests must run offline — no external HTTP. Use mockery + http_mock.
- The /v1 routes are deprecated. Don't add new endpoints under /v1.

Keep entries terse. Add what surprises new contributors. Remove what's wrong.`;

export function MemoryView({ project }: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getMemory(project.id)
      .then((r) => {
        setContent(r.content);
        setOriginal(r.content);
      })
      .catch((e) => setErr(e.message));
  }, [project.id]);

  const dirty = content !== original;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.putMemory(project.id, content);
      setOriginal(r.content);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Project memory</h3>
        <button
          className="primary"
          onClick={save}
          disabled={busy || !dirty}
        >
          {busy ? "Saving..." : saved ? "Saved ✓" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Markdown notes that survive across runs. Loaded into every agent's CLAUDE.md at run root, so they
        see this on every invocation without you re-typing it. Use it for conventions, gotchas, and decisions
        you don't want the team to re-discover.
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={28}
        style={{
          width: "100%",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      />
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 8 }}>
        File: <code>~/.ceo/projects/{project.id}/MEMORY.md</code>
      </div>
      {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}
