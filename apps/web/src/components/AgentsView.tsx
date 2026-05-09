import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentRole, AgentTemplate, ProjectWithRepos } from "@ceo/shared";
import { api } from "../api";
import { t, useLang } from "../i18n";

interface Props {
  project: ProjectWithRepos;
  onChanged: () => Promise<void>;
}

const ROLES: AgentRole[] = ["coder", "reviewer", "tester"];

const ROLE_COLOR: Record<AgentRole, string> = {
  coder: "var(--accent)",
  reviewer: "var(--yellow)",
  tester: "var(--green)",
};

export function AgentsView({ project, onChanged }: Props) {
  useLang();
  const [agents, setAgents] = useState<Agent[]>(project.agents);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setAgents(project.agents);
  }, [project.agents]);

  useEffect(() => {
    api.listAgentTemplates().then(setTemplates).catch(() => {});
  }, []);

  async function refresh() {
    const list = await api.listAgents(project.id);
    setAgents(list);
    await onChanged();
  }

  async function del(agent: Agent) {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteAgent(project.id, agent.id);
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addTemplate(key: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.addAgentFromTemplate(project.id, key);
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Group agents by category for display.
  const grouped = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const c = a.category || "Development";
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(a);
    }
    // Sort: known categories first, alphabetical for the rest.
    const known = ["Development", "Architecture", "Code Review", "QA", "DevOps", "Documentation"];
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ai = known.indexOf(a);
      const bi = known.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [agents]);

  const existingNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents]);

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowTemplates(true)} disabled={busy}>
            {t("btn.add_from_template")}
          </button>
          <button className="primary" onClick={() => setCreating(true)} disabled={busy}>
            + {t("btn.add_specialist")}
          </button>
        </div>
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Specialist definitions: role + system prompt + model + tools. Compose them into Skills,
        Teams, and Playbooks below; pull from the global Admin templates with "Add from template".
      </p>

      {grouped.length === 0 && (
        <div style={{ color: "var(--text-dim)" }}>No agents yet.</div>
      )}

      {grouped.map(([cat, list]) => (
        <div key={cat} style={{ marginBottom: 20 }}>
          <h4 style={{
            margin: "0 0 8px",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 1,
            color: "var(--text-dim)",
            borderBottom: "1px solid var(--border)",
            paddingBottom: 6,
          }}>
            {cat} <span style={{ opacity: 0.6 }}>({list.length})</span>
          </h4>
          <div className="repo-list">
            {list.map((a) => (
              <div key={a.id} className="repo-item" style={{ alignItems: "flex-start" }}>
                <div className="info" style={{ flex: 1 }}>
                  <div className="name">
                    {a.name}{" "}
                    <span style={{
                      color: "white",
                      background: ROLE_COLOR[a.role],
                      padding: "1px 6px",
                      borderRadius: 3,
                      fontSize: 10,
                      marginLeft: 6,
                    }}>{a.role}</span>
                    {a.model && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: 8 }}>
                        model: {a.model}
                      </span>
                    )}
                  </div>
                  <div className="url" style={{ marginTop: 4, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
                    {a.system_prompt.slice(0, 240)}{a.system_prompt.length > 240 ? "…" : ""}
                  </div>
                  {a.allowed_tools && a.allowed_tools.length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                      tools: {a.allowed_tools.join(", ")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setEditing(a)} disabled={busy}>Edit</button>
                  <button className="danger" onClick={() => del(a)} disabled={busy}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 12 }}>{err}</div>}

      {creating && (
        <AgentForm
          mode="create"
          projectId={project.id}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await api.createAgent(project.id, input);
            await refresh();
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <AgentForm
          mode="edit"
          initial={editing}
          projectId={project.id}
          onClose={() => setEditing(null)}
          onSubmit={async (input, memory) => {
            await api.updateAgent(project.id, editing.id, input);
            if (memory !== undefined) {
              await api.putAgentMemory(project.id, editing.id, memory);
            }
            await refresh();
            setEditing(null);
          }}
        />
      )}
      {showTemplates && (
        <TemplatePickerModal
          templates={templates}
          existingNames={existingNames}
          onClose={() => setShowTemplates(false)}
          onAdd={async (key) => {
            await addTemplate(key);
            // keep open so user can add multiple
          }}
        />
      )}
    </div>
  );
}

interface FormProps {
  mode: "create" | "edit";
  initial?: Agent;
  projectId: string;
  onClose: () => void;
  onSubmit: (
    input: {
      name: string;
      role: AgentRole;
      category: string;
      system_prompt: string;
      model: string | null;
      allowed_tools: string[] | null;
    },
    memory?: string,
  ) => Promise<void>;
}

function AgentForm({ mode, initial, projectId, onClose, onSubmit }: FormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState<AgentRole>(initial?.role ?? "coder");
  const [category, setCategory] = useState(initial?.category ?? "Development");
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [toolsCsv, setToolsCsv] = useState((initial?.allowed_tools ?? []).join(", "));
  const [memory, setMemory] = useState<string>("");
  const [memoryLoaded, setMemoryLoaded] = useState(mode === "create");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load this agent's memory when editing.
  useEffect(() => {
    if (mode !== "edit" || !initial) return;
    api.getAgentMemory(projectId, initial.id)
      .then((r) => setMemory(r.content))
      .catch(() => {})
      .finally(() => setMemoryLoaded(true));
  }, [mode, initial?.id, projectId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const tools = toolsCsv.trim()
        ? toolsCsv.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      await onSubmit(
        {
          name: name.trim(),
          role,
          category: category.trim() || "Development",
          system_prompt: systemPrompt,
          model: model.trim() || null,
          allowed_tools: tools,
        },
        mode === "edit" ? memory : undefined,
      );
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        style={{ width: 720, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>{mode === "create" ? "New agent" : `Edit agent: ${initial?.name}`}</h3>
        <div style={{ overflow: "auto", paddingRight: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
            <div className="form-row">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Senior Coder" />
            </div>
            <div className="form-row">
              <label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="form-row">
              <label>Category</label>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Development"
                list="cat-suggestions"
              />
              <datalist id="cat-suggestions">
                <option value="Development" />
                <option value="Architecture" />
                <option value="Code Review" />
                <option value="QA" />
                <option value="DevOps" />
                <option value="Documentation" />
              </datalist>
            </div>
          </div>
          <div className="form-row">
            <label>Model (optional, e.g. claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5-20251001)</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="leave empty for CLI default" />
          </div>
          <div className="form-row">
            <label>Allowed tools (CSV, optional — leave empty for default tool set for this role)</label>
            <input
              value={toolsCsv}
              onChange={(e) => setToolsCsv(e.target.value)}
              placeholder="Read, Edit, Write, Bash, Grep, Glob"
            />
          </div>
          <div className="form-row">
            <label>System prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={14}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          {mode === "edit" && (
            <div className="form-row">
              <label>
                Agent memory (private to this agent in this project) {memoryLoaded ? "" : " — loading..."}
              </label>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
                Appended to this agent's <em>system prompt</em> on every run. Use it for role-specific
                learnings (e.g. "I keep forgetting strict_types"). The shared project knowledge belongs
                in the project Memory tab instead.
              </div>
              <textarea
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                rows={6}
                disabled={!memoryLoaded}
                placeholder="(empty)"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
              />
            </div>
          )}
        </div>
        {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
        <div className="form-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !name.trim() || !systemPrompt.trim()}
          >
            {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface TemplatePickerProps {
  templates: AgentTemplate[];
  existingNames: Set<string>;
  onClose: () => void;
  onAdd: (key: string) => Promise<void>;
}

function TemplatePickerModal({ templates, existingNames, onClose, onAdd }: TemplatePickerProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, AgentTemplate[]>();
    for (const t of templates) {
      if (!map.has(t.category)) map.set(t.category, []);
      map.get(t.category)!.push(t);
    }
    return Array.from(map.entries());
  }, [templates]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 720, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Agent templates</h3>
        <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
          Curated agent definitions you can drop into this project.
        </p>
        <div style={{ overflow: "auto" }}>
          {grouped.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 16 }}>
              <h4 style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "var(--text-dim)",
                marginBottom: 6,
              }}>{cat}</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {list.map((t) => {
                  const exists = existingNames.has(t.name);
                  return (
                    <div
                      key={t.key}
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                        padding: 10,
                        background: "var(--bg-card)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>
                          {t.name}{" "}
                          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                            [{t.role}{t.model ? ` · ${t.model}` : ""}]
                          </span>
                          {t.core && (
                            <span style={{
                              marginLeft: 6,
                              fontSize: 10,
                              padding: "1px 6px",
                              background: "var(--accent)",
                              color: "white",
                              borderRadius: 3,
                            }}>core</span>
                          )}
                        </div>
                        <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 2 }}>
                          {t.description}
                        </div>
                      </div>
                      <button
                        className="primary"
                        disabled={exists}
                        onClick={() => onAdd(t.key)}
                        title={exists ? "Already added" : ""}
                      >
                        {exists ? "Added" : "Add"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="form-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
