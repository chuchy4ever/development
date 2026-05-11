/**
 * Reusable connector-secrets editor. Two scopes:
 *   - { scope: "project", projectId } → reads/writes via /api/projects/:id/secrets
 *   - { scope: "global"  }            → reads/writes via /api/admin/secrets
 *
 * Project values inherit from global ones server-side, so users can leave
 * project fields blank to use admin defaults. The list shows the resolved
 * `source` per row (project / global / env / unset) so it's clear where
 * each value comes from.
 */

import { useEffect, useState } from "react";
import { api, type ProjectSecretMasked } from "../api";
import { t } from "../i18n";

type Scope =
  | { scope: "project"; projectId: string }
  | { scope: "global" };

interface Props {
  scope: Scope;
  /** Optional title override. Defaults: "Connector secrets" / "Výchozí connector secrets". */
  title?: string;
  /** Optional intro paragraph override. */
  intro?: string;
}

export function ConnectorSecretsPanel({ scope, title, intro }: Props) {
  const [items, setItems] = useState<ProjectSecretMasked[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string; tested_at?: string }>>({});

  const adapter = scope.scope === "project"
    ? {
      list: () => api.listProjectSecrets(scope.projectId),
      set: (k: string, v: string) => api.setProjectSecret(scope.projectId, k, v),
      del: (k: string) => api.deleteProjectSecret(scope.projectId, k),
      test: (g: "github" | "jira" | "ssh") => api.testProjectSecretGroup(scope.projectId, g),
      health: () => api.projectConnectorHealth(scope.projectId),
    }
    : {
      list: () => api.listGlobalSecrets(),
      set: (k: string, v: string) => api.setGlobalSecret(k, v),
      del: (k: string) => api.deleteGlobalSecret(k),
      test: (g: "github" | "jira" | "ssh") => api.testGlobalSecretGroup(g),
      health: () => api.globalConnectorHealth(),
    };

  useEffect(() => {
    let cancelled = false;
    adapter.list().then((rows) => {
      if (!cancelled) setItems(rows);
    }).catch((e: unknown) => {
      if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
    });
    // Hydrate the test panel from stored health rows so the user sees last
    // status without re-hitting the connector API on every open.
    adapter.health().then((rows) => {
      if (cancelled) return;
      const next: Record<string, { ok: boolean; message: string; tested_at?: string }> = {};
      for (const r of rows) {
        next[r.group_name] = {
          ok: r.ok,
          message: r.ok ? "OK" : (r.error ?? "failed"),
          tested_at: r.last_tested_at,
        };
      }
      setTests(next);
    }).catch(() => { /* health is best-effort */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.scope, scope.scope === "project" ? scope.projectId : null]);

  async function save(key: string) {
    const value = drafts[key] ?? "";
    setBusy(key);
    setErr(null);
    try {
      const next = await adapter.set(key, value);
      setItems(next);
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function clear(key: string) {
    setBusy(key);
    setErr(null);
    try {
      const next = await adapter.del(key);
      setItems(next);
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function testGroup(group: "github" | "jira" | "ssh") {
    setBusy(`test:${group}`);
    setTests((t) => { const n = { ...t }; delete n[group]; return n; });
    try {
      const r = await adapter.test(group);
      setTests((t) => ({ ...t, [group]: r }));
    } catch (e: unknown) {
      setTests((t) => ({ ...t, [group]: { ok: false, message: e instanceof Error ? e.message : String(e) } }));
    } finally { setBusy(null); }
  }

  const headerTitle = title ?? (scope.scope === "global" ? "Výchozí connector secrets" : "Connector secrets");

  if (items === null) {
    return (
      <div className="settings-section">
        <h3>{headerTitle}</h3>
        {err
          ? <div style={{ color: "var(--red)", fontSize: 12 }}>{err} (server may need restart after backend changes)</div>
          : <div style={{ color: "var(--text-dim)", fontSize: 12 }}>Loading…</div>}
      </div>
    );
  }

  const groups: { title: string; prefix: string }[] = [
    { title: "GitHub", prefix: "github_" },
    { title: "Jira", prefix: "jira_" },
    { title: "SSH", prefix: "ssh_" },
  ];

  // Source chips per row already convey provenance — keep this intro to one line.
  const introText = intro ?? (scope.scope === "global"
    ? "Výchozí credentials. Použijí se pro globální joby a jako fallback pro projekty s prázdným polem."
    : "Prázdné pole = projekt dědí z výchozích (Admin → Connectors) nebo env var.");

  return (
    <div className="settings-section">
      <h3>{headerTitle}</h3>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>{introText}</div>
      {groups.map((g) => {
        const rows = items.filter((i) => i.key.startsWith(g.prefix));
        if (rows.length === 0) return null;
        const groupKey = g.prefix.replace(/_$/, "") as "github" | "jira" | "ssh";
        const testResult = tests[groupKey];
        const testing = busy === `test:${groupKey}`;
        return (
          <div key={g.prefix} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-dim)" }}>{g.title}</div>
              <button onClick={() => testGroup(groupKey)} disabled={!!busy} style={{ fontSize: 10, padding: "2px 8px" }}>
                {testing ? "Testuje se…" : "Test připojení"}
              </button>
              {testResult && (
                <span style={{ fontSize: 11, color: testResult.ok ? "var(--green)" : "var(--red)" }}>
                  {testResult.ok ? "✓" : "✗"} {testResult.message}
                  {testResult.tested_at && (
                    <span style={{ marginLeft: 6, color: "var(--text-dim)", fontWeight: 400 }}>
                      · {formatRelativeAge(testResult.tested_at)}
                    </span>
                  )}
                </span>
              )}
            </div>
            {rows.map((item) => {
              const isDirty = drafts[item.key] !== undefined;
              const draftValue = drafts[item.key] ?? "";
              return (
                <div key={item.key} style={{ display: "grid", gridTemplateColumns: "180px 1fr auto auto", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }} title={item.hint}>
                    {item.label}
                    {item.source === "env" && <span style={{ marginLeft: 4, fontSize: 10, color: "#ca8a04" }} title="Coming from env var">env</span>}
                    {item.source === "project" && <span style={{ marginLeft: 4, fontSize: 10, color: "var(--green)" }} title={scope.scope === "global" ? "Nastaveno ve výchozích" : "Nastaveno v tomto projektu"}>✓</span>}
                  </label>
                  <input
                    type={item.secret ? "password" : "text"}
                    value={isDirty ? draftValue : ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [item.key]: e.target.value }))}
                    placeholder={item.display || (item.secret ? "(not set)" : item.hint ?? "(not set)")}
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                  />
                  <button onClick={() => save(item.key)} disabled={!isDirty || busy === item.key} className={isDirty ? "primary" : ""}>
                    {busy === item.key ? "..." : "Save"}
                  </button>
                  <button onClick={() => clear(item.key)} disabled={!item.has_project_value || busy === item.key}>
                    Clear
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
      {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
    </div>
  );
}

/** Compact "5m ago" / "2h ago" / "3d ago" formatter for the last-tested
 *  timestamp on connector health. Threshold based, no localization. */
function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return t("age.just_now");
  if (m < 60) return t("age.minutes", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("age.hours", { n: h });
  const d = Math.floor(h / 24);
  return t("age.days", { n: d });
}
