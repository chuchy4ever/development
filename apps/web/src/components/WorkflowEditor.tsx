import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveRunSummary,
  Agent,
  AgentRole,
  AgentTemplate,
  Playbook,
  ProjectWithRepos,
  SkillCategory,
  Team,
  Ticket,
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowPreset,
} from "@ceo/shared";
import {
  deriveSkillCategory,
  SKILL_CATEGORY_LABEL,
  SKILL_CATEGORY_ORDER,
} from "@ceo/shared";
import { api } from "../api";
import { AgentForm } from "./AgentsView";
import { t, useLang } from "../i18n";
import { useEscClose } from "../hooks";

/** Agents that are part of the platform's internals — not user-facing
 *  specialists Director dispatches into the playbook. Hidden from the
 *  Skills panel so the user isn't confused by a roster that doesn't match
 *  the playbook. They still exist in the DB and run their internal
 *  workflows (Memory Curator updates project memory, CTO decomposes). */
const INTERNAL_AGENT_NAMES = new Set(["Memory Curator", "CTO", "Director"]);
import { CodeEditorModal } from "./CodeEditorModal";

interface Props {
  project: ProjectWithRepos;
  tickets?: Ticket[];
  /** Callback to refresh project (incl. agents) after edits in the embedded
   *  Specialists section. Provided by ProjectView. */
  onChanged?: () => Promise<void>;
}

/** UI-only mirror of the server task registry. Adding a new task type means
 *  registering it here (icon, color, palette label, default config, summary). */
const TASK_TYPES: Record<string, {
  label: string;
  icon: string;
  color: string;
  defaultConfig: Record<string, unknown>;
  summary: (cfg: Record<string, unknown>) => string;
}> = {
  shell: {
    label: "Shell",
    icon: "▷_",
    color: "#1e293b",
    defaultConfig: { command: "make ci", timeout_sec: 600 },
    summary: (c) => String(c.command ?? "").slice(0, 32),
  },
  telegram: {
    label: "Telegram",
    icon: "✈",
    color: "#0ea5e9",
    defaultConfig: {
      bot_token: "",
      chat_id: "",
      template: "{verdict_status} {ticket_key} {ticket_title}\n{verdict_summary}",
      on: "always",
      parse_mode: "Markdown",
    },
    summary: (c) => `→ chat ${String(c.chat_id ?? "?")}`,
  },
};

interface TaskFormProps {
  phase: WorkflowPhase;
  onChangeType: (type: string) => void;
  onChangeConfig: (config: Record<string, unknown>) => void;
}

function getCurrentConfig(phase: WorkflowPhase): Record<string, unknown> {
  if (phase.kind === "task") return (phase.task?.config ?? {}) as Record<string, unknown>;
  if (phase.kind === "command") {
    return {
      command: phase.command ?? "",
      ...(phase.working_dir !== undefined ? { working_dir: phase.working_dir } : {}),
      ...(phase.timeout_sec !== undefined ? { timeout_sec: phase.timeout_sec } : {}),
    };
  }
  return {};
}

interface CodePreviewButtonProps {
  value: string;
  emptyLabel: string;
  onClick: () => void;
}
function CodePreviewButton({ value, emptyLabel, onClick }: CodePreviewButtonProps) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const truncated = trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
  return (
    <button type="button" className="code-preview-button" onClick={onClick}>
      {trimmed ? (
        <span className="preview-text">{truncated}</span>
      ) : (
        <span className="preview-text preview-empty">{emptyLabel}</span>
      )}
      <span className="preview-edit-glyph">Edit ▸</span>
    </button>
  );
}

function TaskFormSection({ phase, onChangeType, onChangeConfig }: TaskFormProps) {
  const type = getTaskKindForPhase(phase) ?? "shell";
  const config = getCurrentConfig(phase);
  const setField = (key: string, value: unknown) => onChangeConfig({ ...config, [key]: value });
  const [editing, setEditing] = useState<null | { field: string; lang: "bash" | "template"; title: string; hint?: string }>(null);

  return (
    <>
      <div className="form-row">
        <label>task type</label>
        <select value={type} onChange={(e) => onChangeType(e.target.value)}>
          {Object.entries(TASK_TYPES).map(([t, meta]) => (
            <option key={t} value={t}>
              {meta.label}
            </option>
          ))}
        </select>
      </div>
      {type === "shell" && (
        <>
          <div className="form-row">
            <label>command</label>
            <CodePreviewButton
              value={String(config.command ?? "")}
              emptyLabel="(empty — click to write a shell command)"
              onClick={() => setEditing({
                field: "command",
                lang: "bash",
                title: `Edit shell command — ${phase.id}`,
                hint: "Runs via bash -lc in the run worktree. Exit 0 → next; non-zero → retry target.",
              })}
            />
          </div>
          <div className="form-row">
            <label>working dir (relative to run root, optional)</label>
            <input
              value={String(config.working_dir ?? "")}
              onChange={(e) => setField("working_dir", e.target.value || null)}
              placeholder="(run root)"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>timeout (seconds, max 1800)</label>
            <input
              type="number"
              min={1}
              max={1800}
              value={Number(config.timeout_sec ?? 600)}
              onChange={(e) => setField("timeout_sec", Number(e.target.value))}
            />
          </div>
        </>
      )}
      {type === "telegram" && (
        <>
          <div className="form-row">
            <label>bot token</label>
            <input
              type="password"
              value={String(config.bot_token ?? "")}
              onChange={(e) => setField("bot_token", e.target.value)}
              placeholder="123456:AAH..."
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              ⚠ Stored in plain text in the workflow JSON. Save-as-template will redact this.
            </div>
          </div>
          <div className="form-row">
            <label>chat id</label>
            <input
              value={String(config.chat_id ?? "")}
              onChange={(e) => setField("chat_id", e.target.value)}
              placeholder="-1001234567890 or @channelname"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>message template</label>
            <CodePreviewButton
              value={String(config.template ?? "")}
              emptyLabel="(empty — click to write a message template)"
              onClick={() => setEditing({
                field: "template",
                lang: "template",
                title: `Edit message template — ${phase.id}`,
                hint: "Placeholders: {ticket_key} {ticket_title} {project_name} {run_id} {verdict_summary} {verdict_status}",
              })}
            />
          </div>
          <div className="form-row">
            <label>send when</label>
            <select
              value={String(config.on ?? "always")}
              onChange={(e) => setField("on", e.target.value)}
            >
              <option value="always">always</option>
              <option value="success">only on success (previous phase ok)</option>
              <option value="failure">only on failure (previous phase not ok)</option>
            </select>
          </div>
          <div className="form-row">
            <label>parse mode</label>
            <select
              value={String(config.parse_mode ?? "Markdown")}
              onChange={(e) => setField("parse_mode", e.target.value)}
            >
              <option value="">none (plain text)</option>
              <option value="Markdown">Markdown</option>
              <option value="MarkdownV2">MarkdownV2</option>
              <option value="HTML">HTML</option>
            </select>
          </div>
        </>
      )}
      {editing && (
        <CodeEditorModal
          title={editing.title}
          value={String(config[editing.field] ?? "")}
          language={editing.lang}
          hint={editing.hint}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            setField(editing.field, next);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function getTaskKindForPhase(phase: WorkflowPhase): string | null {
  // Legacy "command" → shell.
  if (phase.kind === "command") return "shell";
  if (phase.kind === "task") return phase.task?.type ?? null;
  return null;
}



function clonePhase(p: WorkflowPhase): WorkflowPhase {
  return { ...p, position: p.position ? { ...p.position } : null };
}


/**
 * Collapsible panel above the canvas for managing named Playbooks.
 *
 * A Playbook is a recipe Director can pick: a name, when-to-use description,
 * and an ordered list of skill/gate references. The user composes them from
 * the existing skills/gates in the canvas; on apply, Director can call
 * `use_playbook` to walk the whole recipe in one go.
 */
function NamedPlaybooksPanel({
  wf,
  agentsById,
  onChange,
}: {
  wf: WorkflowDefinition;
  agentsById: Map<string, Agent>;
  onChange: (updater: (next: WorkflowDefinition) => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const playbooks = wf.playbooks ?? [];
  const phases = wf.phases.filter((p) => p.kind !== "director");

  const updatePlaybook = (idx: number, patch: Partial<{ name: string; description: string; steps: WorkflowDefinition["playbooks"] extends (infer U)[] | undefined ? U extends { steps: infer S } ? S : never : never }>) => {
    onChange((next) => {
      if (!next.playbooks) return;
      const cur = next.playbooks[idx];
      if (!cur) return;
      Object.assign(cur, patch);
    });
  };

  const phaseLabel = (phaseId: string) => {
    const p = wf.phases.find((x) => x.id === phaseId);
    if (!p) return `${phaseId} (missing)`;
    if (p.kind === "agent" && p.agent_id) {
      const a = agentsById.get(p.agent_id);
      return `${phaseId}${a ? ` · ${a.name}` : ""}`;
    }
    if (p.kind === "task") return `${phaseId} · ${p.task?.type ?? "gate"} (gate)`;
    if (p.kind === "approval") return `${phaseId} · approval`;
    return phaseId;
  };

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: 8, fontSize: 12,
      background: "var(--bg-elev)",
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", padding: "8px 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "transparent", border: 0, color: "var(--text)", cursor: "pointer",
          textAlign: "left", fontSize: 13,
        }}
      >
        <span><b>{t("section.playbooks.title")}</b> <span style={{ color: "var(--text-dim)" }}>· {t(playbooks.length === 1 ? "section.playbooks.summary_one" : "section.playbooks.summary_many", { count: playbooks.length })}</span></span>
        <span style={{ color: "var(--text-dim)" }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 12px", borderTop: "1px solid var(--border)" }}>
          {playbooks.length === 0 && (
            <div style={{ color: "var(--text-dim)", padding: "12px 0" }}>
              {t("section.playbooks.empty")}
            </div>
          )}
          {playbooks.map((pb, idx) => (
            <div key={idx} style={{
              border: "1px solid var(--border)", borderRadius: 6,
              padding: 10, marginTop: 10, background: "var(--bg)",
            }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <input
                  value={pb.name}
                  placeholder="recipe name (e.g. small_change)"
                  onChange={(e) => updatePlaybook(idx, { name: e.target.value })}
                  style={{ flex: "0 0 220px", fontFamily: "ui-monospace,monospace" }}
                />
                <input
                  value={pb.description}
                  placeholder="when to use (e.g. trivial endpoint addition, small bugfix)"
                  onChange={(e) => updatePlaybook(idx, { description: e.target.value })}
                  style={{ flex: 1 }}
                />
                <button
                  onClick={() => onChange((next) => { next.playbooks = (next.playbooks ?? []).filter((_, i) => i !== idx); })}
                  title="Remove playbook"
                >×</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>Steps (Director walks them in order):</div>
              {pb.steps.map((step, sIdx) => (
                <div key={sIdx} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                  <span style={{ color: "var(--text-dim)", width: 16 }}>{sIdx + 1}.</span>
                  <select
                    value={step.phase_id}
                    onChange={(e) => onChange((next) => {
                      const s = next.playbooks?.[idx]?.steps[sIdx];
                      if (s) s.phase_id = e.target.value;
                    })}
                    style={{ flex: 1 }}
                  >
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>{phaseLabel(p.id)}</option>
                    ))}
                  </select>
                  <label style={{ display: "flex", gap: 4, alignItems: "center", color: "var(--text-dim)" }}>
                    <input
                      type="checkbox"
                      checked={!!step.optional}
                      onChange={(e) => onChange((next) => {
                        const s = next.playbooks?.[idx]?.steps[sIdx];
                        if (s) s.optional = e.target.checked || undefined;
                      })}
                    />
                    optional
                  </label>
                  <button onClick={() => onChange((next) => {
                    const pb2 = next.playbooks?.[idx];
                    if (pb2) pb2.steps = pb2.steps.filter((_, i) => i !== sIdx);
                  })} title="Remove step">×</button>
                </div>
              ))}
              <button
                style={{ marginTop: 4 }}
                onClick={() => onChange((next) => {
                  const pb2 = next.playbooks?.[idx];
                  if (pb2 && phases[0]) pb2.steps.push({ phase_id: phases[0].id });
                })}
                disabled={phases.length === 0}
              >+ {t("btn.add_step")}</button>
            </div>
          ))}
          <button
            style={{ marginTop: 10 }}
            onClick={() => onChange((next) => {
              if (!next.playbooks) next.playbooks = [];
              next.playbooks.push({ name: `recipe_${next.playbooks.length + 1}`, description: "", steps: [] });
            })}
          >+ {t("btn.add_playbook")}</button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Stacked-panels editor (no graph) ──────────────── */

/**
 * Skills panel — agent phases as a flat list, grouped by capability category.
 * Replaces the graph canvas for skills. Each row opens the existing edit
 * modal on click. Add at the bottom.
 */
function SkillsPanel({
  wf,
  agentsById,
  agents,
  projectId,
  onSelect,
  onAdd,
  onAddNew,
  onImportLibrary,
  onAgentsChanged,
}: {
  wf: WorkflowDefinition;
  agentsById: Map<string, Agent>;
  agents: Agent[];
  projectId: string;
  onSelect: (phaseId: string) => void;
  onAdd: () => void;
  onAddNew: () => void;
  onImportLibrary: () => void;
  onAgentsChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const skills = wf.phases.filter((p) => (p.kind === "agent" || !p.kind) && p.id !== "__director__");
  // Orphaned agents = agents not referenced by any skill, not internal, not
  // a built-in role default. Surfaced as a tiny cleanup affordance.
  const usedAgentIds = new Set(skills.map((s) => s.agent_id).filter(Boolean) as string[]);
  const orphans = agents.filter((a) => !INTERNAL_AGENT_NAMES.has(a.name) && !usedAgentIds.has(a.id));

  // Group by derived category
  const byCategory = new Map<SkillCategory, WorkflowPhase[]>();
  for (const s of skills) {
    const a = s.agent_id ? agentsById.get(s.agent_id) : null;
    const cat = deriveSkillCategory(s, a ? { name: a.name, role: a.role } : null);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(s);
  }

  return (
    <CollapsibleSection
      open={open}
      onToggle={() => setOpen((o) => !o)}
      title={t("section.skills.title")}
      summary={t(skills.length === 1 ? "section.skills.summary_one" : "section.skills.summary_many", { count: skills.length })}
      icon="🧑‍💻"
    >
      {SKILL_CATEGORY_ORDER.map((cat) => {
        const list = byCategory.get(cat);
        if (!list || list.length === 0) return null;
        return (
          <div key={cat} style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
              {SKILL_CATEGORY_LABEL[cat]}
            </div>
            {list.map((p) => {
              const a = p.agent_id ? agentsById.get(p.agent_id) : null;
              const fromLibrary = !!a?.template_key;
              return (
                <button
                  key={p.id}
                  onClick={() => onSelect(p.id)}
                  className="row-card"
                  style={{ width: "100%", textAlign: "left" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div>
                      <code style={{ background: "var(--gray-soft)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>{p.id}</code>
                      <span style={{ marginLeft: 8, fontWeight: 500 }}>{a?.name ?? "(missing agent)"}</span>
                      {fromLibrary && (
                        <span title={`Library template: ${a?.template_key}`} style={{
                          marginLeft: 6, fontSize: 10, padding: "1px 6px", borderRadius: 8,
                          background: "rgba(14, 165, 233, 0.12)", color: "#0369a1",
                          border: "1px solid rgba(14, 165, 233, 0.3)",
                        }}>📚 Library</span>
                      )}
                      {a?.model && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-dim)" }}>· {a.model}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      {p.notes ? "📝 has notes · " : ""}{p.retry_target ? `↻ ${p.retry_target}` : ""}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        <button onClick={onImportLibrary} className="primary" title="Import a skill from the global Admin library — locked to admin, propagates updates to all projects">
          📚 Import from library
        </button>
        <button onClick={onAdd} title="Add a skill (phase) using an existing local agent">
          + {t("btn.add_skill")}
        </button>
        <button onClick={onAddNew} title="Create a new local specialist (agent definition) for this project only">
          + {t("btn.add_specialist")}
        </button>
        {orphans.length > 0 && (
          <button
            onClick={async () => {
              const names = orphans.map((a) => a.name).join(", ");
              if (!confirm(`Delete ${orphans.length} unused agent(s)? They have no skill referencing them.\n\n${names}`)) return;
              for (const a of orphans) {
                try { await api.deleteAgent(projectId, a.id); } catch { /* non-fatal */ }
              }
              await onAgentsChanged();
            }}
            style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}
            title={`Unused: ${orphans.map((a) => a.name).join(", ")}`}
          >
            🧹 Cleanup unused ({orphans.length})
          </button>
        )}
      </div>
    </CollapsibleSection>
  );
}

/**
 * Gates panel — deterministic checks (shell tasks, approval, etc.).
 */
function GatesPanel({
  wf,
  onSelect,
  onAddTask,
  onAddApproval,
}: {
  wf: WorkflowDefinition;
  onSelect: (phaseId: string) => void;
  onAddTask: (type: string) => void;
  onAddApproval: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const gates = wf.phases.filter((p) => p.kind === "task" || p.kind === "command" || p.kind === "approval");
  return (
    <CollapsibleSection
      open={open}
      onToggle={() => setOpen((o) => !o)}
      title={t("section.gates.title")}
      summary={t(gates.length === 1 ? "section.gates.summary_one" : "section.gates.summary_many", { count: gates.length })}
      icon="🛡"
    >
      {gates.length === 0 && (
        <div style={{ color: "var(--text-dim)", padding: "8px 0" }}>
          {t("section.gates.empty")}
        </div>
      )}
      {gates.map((p) => {
        const taskType = p.kind === "task" ? p.task?.type : p.kind === "approval" ? "approval" : "shell";
        const meta = TASK_TYPES[taskType ?? "shell"];
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className="row-card"
            style={{ width: "100%", textAlign: "left" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div>
                <span style={{
                  display: "inline-block", width: 22, height: 22, lineHeight: "22px",
                  textAlign: "center", borderRadius: 4, marginRight: 8,
                  background: meta?.color ?? (p.kind === "approval" ? "#f59e0b" : "#666"),
                  color: "#fff", fontSize: 11,
                }}>{meta?.icon ?? (p.kind === "approval" ? "⏸" : "?")}</span>
                <code style={{ background: "var(--gray-soft)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>{p.id}</code>
                <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-dim)" }}>
                  {p.kind === "approval" ? "approval" : (meta?.label ?? taskType)}
                </span>
              </div>
            </div>
          </button>
        );
      })}
      <div style={{ position: "relative", marginTop: 10 }}>
        <button onClick={() => setAddOpen((o) => !o)}>+ {t("btn.add_gate")}</button>
        {addOpen && (
          <div className="wf-popover" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 10 }}>
            {Object.entries(TASK_TYPES).map(([key, meta]) => (
              <button
                key={key}
                onClick={() => { onAddTask(key); setAddOpen(false); }}
              >
                <span className="pop-icon" style={{ background: meta.color }}>{meta.icon}</span>
                {meta.label}
              </button>
            ))}
            <button onClick={() => { onAddApproval(); setAddOpen(false); }}>
              <span className="pop-icon" style={{ background: "#f59e0b" }}>⏸</span>
              Approval gate
            </button>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}


/**
 * Inline agent editor inside the Skill modal — renders the agent's
 * definition fields (name, role, model, tools, prompt) directly in the
 * skill editor. The user no longer needs a separate "Edit agent" button:
 * skill = agent (with project-specific notes/category/retry on top).
 *
 * Behavior:
 *  - agent dropdown lets you point this skill at a different agent (rare
 *    but supported — e.g. switch reviewer for a stricter variant).
 *  - editable fields debounce-save to api.updateAgent. If the agent is
 *    referenced by other phases, a small "shared with N skills" warning
 *    appears so the user knows the change propagates locally.
 *  - if the agent is library-linked (template_key set), all definition
 *    fields are disabled and a 📚 banner sends the user to admin instead.
 */
function SkillAgentEditor({
  phase,
  project,
  onPickAgent,
  onAgentSaved,
  view = "all",
}: {
  phase: WorkflowPhase;
  project: ProjectWithRepos;
  onPickAgent: (agentId: string) => void;
  onAgentSaved: () => Promise<void>;
  /** Which slice of the editor to render. "picker" = just the switch-agent
   *  dropdown + library/sharing banners. "definition" = the editable agent
   *  fields (name/role/model/tools/prompt). "all" = both stacked. */
  view?: "all" | "picker" | "definition";
}) {
  const agent = phase.agent_id ? project.agents.find((a) => a.id === phase.agent_id) ?? null : null;
  const fromLibrary = !!agent?.template_key;
  // Count phases that reference this same agent — informs the user that
  // editing here propagates to those siblings too.
  const sharedCount = agent
    ? project.workflow.phases.filter((p) => p.agent_id === agent.id && p.id !== phase.id).length
    : 0;

  // Local edit state mirrors the agent's fields. We commit to the server
  // when the user blurs a field (or types and pauses for 700 ms) so the
  // Done button doesn't have to coordinate two saves.
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState<AgentRole>(agent?.role ?? "coder");
  const [model, setModel] = useState(agent?.model ?? "");
  const [toolsCsv, setToolsCsv] = useState((agent?.allowed_tools ?? []).join(", "));
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? "");
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // When the picker switches the underlying agent, refresh the local fields.
  useEffect(() => {
    setName(agent?.name ?? "");
    setRole(agent?.role ?? "coder");
    setModel(agent?.model ?? "");
    setToolsCsv((agent?.allowed_tools ?? []).join(", "));
    setSystemPrompt(agent?.system_prompt ?? "");
    setSavingState("idle");
    setSaveErr(null);
  }, [agent?.id]);

  // Debounced patch.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!agent || fromLibrary) return;
    // Skip the initial sync triggered by the effect above.
    const same = name === (agent.name ?? "")
      && role === agent.role
      && (model || null) === (agent.model ?? null)
      && toolsCsv === (agent.allowed_tools ?? []).join(", ")
      && systemPrompt === agent.system_prompt;
    if (same) return;
    dirtyRef.current = true;
    const t = window.setTimeout(async () => {
      setSavingState("saving");
      setSaveErr(null);
      try {
        const tools = toolsCsv.trim()
          ? toolsCsv.split(",").map((s) => s.trim()).filter(Boolean)
          : null;
        await api.updateAgent(project.id, agent.id, {
          name: name.trim(),
          role,
          category: agent.category,
          system_prompt: systemPrompt,
          model: model.trim() || null,
          allowed_tools: tools,
        });
        await onAgentSaved();
        setSavingState("saved");
        dirtyRef.current = false;
      } catch (e: any) {
        setSavingState("error");
        setSaveErr(e?.message ?? String(e));
      }
    }, 700);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, role, model, toolsCsv, systemPrompt]);

  if (!agent) {
    return (
      <div className="form-row">
        <label>Agent</label>
        <select
          value={phase.agent_id ?? ""}
          onChange={(e) => onPickAgent(e.target.value)}
        >
          <option value="">(missing — pick one)</option>
          {project.agents
            .filter((a) => !INTERNAL_AGENT_NAMES.has(a.name))
            .map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
            ))}
        </select>
      </div>
    );
  }

  const showPicker = view === "all" || view === "picker";
  const showDefinition = view === "all" || view === "definition";
  return (
    <>
      {showPicker && fromLibrary && (
        <div style={{
          padding: "8px 12px", borderRadius: 6,
          background: "rgba(14, 165, 233, 0.08)",
          border: "1px solid rgba(14, 165, 233, 0.3)",
          fontSize: 12, color: "#0369a1",
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 12,
        }}>
          <span style={{ fontSize: 16 }}>📚</span>
          <span style={{ flex: 1 }}>
            From global library (<code>{agent.template_key}</code>) — definition is read-only here. Edit in <b>Admin → Skill templates</b>.
          </span>
          <button
            type="button"
            onClick={() => { window.location.hash = "#/admin/templates"; }}
          >Open in Admin</button>
        </div>
      )}
      {showPicker && !fromLibrary && sharedCount > 0 && (
        <div style={{
          padding: "6px 10px", borderRadius: 6,
          background: "rgba(245, 158, 11, 0.08)",
          border: "1px solid rgba(245, 158, 11, 0.3)",
          fontSize: 11, color: "#92400e",
          marginBottom: 12,
        }}>
          🔗 This agent is also used by {sharedCount} other skill{sharedCount === 1 ? "" : "s"} in this project — edits propagate.
        </div>
      )}
      {showPicker && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, fontSize: 11, color: "var(--text-dim)" }}>
          <span>Switch agent for this skill:</span>
          <select
            value={agent.id}
            onChange={(e) => onPickAgent(e.target.value)}
            style={{ flex: 1, fontSize: 12 }}
          >
            {project.agents
              .filter((a) => !INTERNAL_AGENT_NAMES.has(a.name))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role}{a.model ? `, ${a.model}` : ""}{a.template_key ? ` · 📚 ${a.template_key}` : ""})
                </option>
              ))}
          </select>
        </div>
      )}
      {showDefinition && (<>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
        <div className="form-row">
          <label>Name</label>
          <input value={name} disabled={fromLibrary} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Role</label>
          <select value={role} disabled={fromLibrary} onChange={(e) => setRole(e.target.value as AgentRole)}>
            <option value="coder">coder</option>
            <option value="reviewer">reviewer</option>
            <option value="tester">tester</option>
          </select>
        </div>
        <div className="form-row">
          <label>Model</label>
          <input value={model} disabled={fromLibrary} onChange={(e) => setModel(e.target.value)} placeholder="(default)" />
        </div>
      </div>
      <div className="form-row">
        <label>Allowed tools (CSV)</label>
        <input
          value={toolsCsv}
          disabled={fromLibrary}
          onChange={(e) => setToolsCsv(e.target.value)}
          placeholder="Read, Edit, Bash, Grep, Glob"
        />
      </div>
      <div className="form-row">
        <label>
          System prompt
          {savingState === "saving" && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-dim)" }}>saving…</span>}
          {savingState === "saved" && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--green)" }}>✓ saved</span>}
          {savingState === "error" && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--red)" }}>error</span>}
        </label>
        <textarea
          value={systemPrompt}
          disabled={fromLibrary}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={10}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
        />
        {saveErr && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>{saveErr}</div>}
      </div>
      </>)}
    </>
  );
}

/**
 * Picker for global Skill templates (admin library). Imports create a
 * library-linked agent (template_key set) + auto-create a phase using
 * the template's default_notes and default_skill_category.
 */
function LibrarySkillPicker({
  templates,
  existingTemplateKeys,
  existingNames,
  onClose,
  onImport,
}: {
  templates: AgentTemplate[];
  existingTemplateKeys: Set<string>;
  existingNames: Set<string>;
  onClose: () => void;
  onImport: (key: string) => Promise<void>;
}) {
  useEscClose(onClose);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Group by capability category — same axis Skills panel uses.
  const byCat = new Map<SkillCategory, AgentTemplate[]>();
  for (const tpl of templates) {
    const cat = (tpl.default_skill_category as SkillCategory | undefined)
      ?? deriveSkillCategory({ id: "x", kind: "agent" } as WorkflowPhase, { name: tpl.name, role: tpl.role });
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(tpl);
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal" role="dialog" aria-modal="true"
        style={{ width: "min(720px, 95vw)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>📚 Import skill from library</h3>
          <button onClick={onClose} style={{ background: "transparent", border: 0, fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
          Imported skills are <b>locked in the project</b> — edit them in <b>Admin → Skill templates</b> so changes propagate to all projects sharing the template.
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {SKILL_CATEGORY_ORDER.map((cat) => {
            const list = byCat.get(cat);
            if (!list || list.length === 0) return null;
            return (
              <div key={cat} style={{ marginBottom: 16 }}>
                <div style={{
                  fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
                  letterSpacing: 0.5, marginBottom: 6,
                }}>{SKILL_CATEGORY_LABEL[cat]}</div>
                {list.map((tpl) => {
                  const alreadyImported = existingTemplateKeys.has(tpl.key);
                  const nameTaken = !alreadyImported && existingNames.has(tpl.name);
                  return (
                    <div
                      key={tpl.key}
                      style={{
                        border: "1px solid var(--border)", borderRadius: 6,
                        padding: 10, marginBottom: 6, background: "var(--bg)",
                        opacity: alreadyImported || nameTaken ? 0.55 : 1,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>
                            {tpl.name}{" "}
                            <span style={{ color: "var(--text-dim)", fontSize: 11, fontWeight: 400 }}>
                              ({tpl.role}{tpl.model ? `, ${tpl.model}` : ""})
                            </span>
                          </div>
                          {tpl.description && (
                            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
                              {tpl.description}
                            </div>
                          )}
                        </div>
                        <button
                          disabled={alreadyImported || nameTaken || busyKey !== null}
                          onClick={async () => {
                            setBusyKey(tpl.key);
                            try { await onImport(tpl.key); } finally { setBusyKey(null); }
                          }}
                        >
                          {alreadyImported ? "✓ imported" : nameTaken ? "name taken" : busyKey === tpl.key ? "…" : "Import"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {templates.length === 0 && (
            <div style={{ color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
              No skill templates configured yet. Add some in Admin → Skill templates.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CollapsibleSection({
  open,
  onToggle,
  title,
  summary,
  icon,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  summary: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-elev)" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%", padding: "10px 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "transparent", border: 0, color: "var(--text)", cursor: "pointer",
          textAlign: "left", fontSize: 13,
        }}
      >
        <span><span style={{ marginRight: 8 }}>{icon}</span><b>{title}</b> <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>· {summary}</span></span>
        <span style={{ color: "var(--text-dim)" }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div style={{ padding: "0 14px 12px", borderTop: "1px solid var(--border)" }}>{children}</div>}
    </div>
  );
}


export function WorkflowEditor({ project, tickets, onChanged }: Props) {
  useLang(); // re-render on language change
  // Suppress unused-prop warning — `tickets` was needed by the old graph
  // canvas to show the queued-tickets badge on the entry phase. The new
  // panel-based UI doesn't surface that any more.
  void tickets;
  const [wf, setWf] = useState<WorkflowDefinition | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRunSummary[]>([]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  // When set, opens the AgentForm modal in edit mode for this agent id —
  // launched from inside the Skill modal so the user can tweak the agent's
  // prompt/model/tools without leaving the playbook editor.
  // When true, opens AgentForm in create mode for "+ New specialist & skill".
  const [creatingNewAgent, setCreatingNewAgent] = useState(false);
  // Active tab inside the phase-edit modal. Defaults to "skill" (the
  // most-edited fields: id, category, notes, agent picker). "agent" shows
  // the prompt/role/model/tools (or library lock banner). "advanced"
  // surfaces the legacy graph-flow hints.
  const [phaseModalTab, setPhaseModalTab] = useState<"skill" | "agent" | "advanced">("skill");
  // Reset to first tab when a different phase opens, so the user always
  // lands on the same default view.
  useEffect(() => { setPhaseModalTab("skill"); }, [selectedPhaseId]);
  // Library picker — pulls global Skill templates from admin.
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [libraryTemplates, setLibraryTemplates] = useState<AgentTemplate[]>([]);
  useEffect(() => {
    if (!showLibraryPicker) return;
    api.listAgentTemplates().then(setLibraryTemplates).catch(() => {});
  }, [showLibraryPicker]);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try { return localStorage.getItem("ceo.banner.director.dismissed") === "1"; } catch { return false; }
  });

  const agentsById = useMemo(
    () => new Map(project.agents.map((a) => [a.id, a])),
    [project.agents],
  );
  void activeRuns; // surfaced via the Board's CategoryLanes; not needed in the editor itself

  useEffect(() => {
    api
      .getWorkflow(project.id)
      .then((w) => {
        setWf(w);
        setDirty(false);
      })
      .catch((e) => setErr(e.message));
  }, [project.id]);

  // Poll active runs while editor is open.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const list = await api.listActiveRuns(project.id);
        if (!cancelled) setActiveRuns(list);
      } catch {}
    }
    tick();
    const t = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [project.id]);

  const updateWf = useCallback((mut: (next: WorkflowDefinition) => void) => {
    setWf((cur) => {
      if (!cur) return cur;
      // Deep-clone everything mut() might touch. Phases are clonePhase'd because
      // they have nested task.config / approval / director objects. Teams,
      // playbooks, and director_config use structuredClone — they're plain
      // JSON, not class instances.
      const next: WorkflowDefinition = {
        ...cur,
        phases: cur.phases.map(clonePhase),
        teams: cur.teams ? structuredClone(cur.teams) : undefined,
        playbooks: cur.playbooks ? structuredClone(cur.playbooks) : undefined,
        director_config: cur.director_config ? structuredClone(cur.director_config) : cur.director_config,
      };
      mut(next);
      return next;
    });
    setDirty(true);
  }, []);


  // Esc closes the phase editor modal. Must sit with other top-level hooks
  // (above any early-return) so the hook count stays stable across renders.
  useEffect(() => {
    if (selectedPhaseId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedPhaseId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedPhaseId]);

  if (err) return <div style={{ color: "var(--red)" }}>{err}</div>;
  if (!wf) return <div style={{ color: "var(--text-dim)" }}>Loading playbook…</div>;
  if (project.agents.length === 0) {
    return (
      <div style={{ color: "var(--text-dim)" }}>
        This project has no agents yet. Create some on the <b>Agents</b> tab first.
      </div>
    );
  }

  const selected = wf.phases.find((p) => p.id === selectedPhaseId) ?? null;

  function updatePhase(id: string, patch: Partial<WorkflowPhase>) {
    updateWf((next) => {
      const p = next.phases.find((x) => x.id === id);
      if (p) Object.assign(p, patch);
    });
  }

  function addPhase() {
    updateWf((next) => {
      const id = `phase${next.phases.length + 1}`;
      const firstAgent = project.agents[0]!;
      const xs = next.phases.map((p) => p.position?.x ?? 0).concat([0]);
      const x = Math.max(...xs) + 240;
      const y = 120;
      next.phases.push({
        id,
        agent_id: firstAgent.id,
        next: null,
        position: { x, y },
      });
    });
  }

  function addApprovalPhase() {
    updateWf((next) => {
      const id = `approve${next.phases.length + 1}`;
      const xs = next.phases.map((p) => p.position?.x ?? 0).concat([0]);
      const x = Math.max(...xs) + 240;
      const y = 120;
      next.phases.push({
        id,
        kind: "approval",
        approval: { message: "Review the diffs and verdicts above. Approve to continue, or Reject to bounce back." },
        next: null,
        position: { x, y },
      });
      setSelectedPhaseId(id);
    });
  }

  function addTaskPhase(type: string) {
    updateWf((next) => {
      const meta = TASK_TYPES[type];
      const idPrefix = type === "shell" ? "cmd" : type;
      const id = `${idPrefix}${next.phases.length + 1}`;
      const xs = next.phases.map((p) => p.position?.x ?? 0).concat([0]);
      const x = Math.max(...xs) + 240;
      const y = 120;
      next.phases.push({
        id,
        kind: "task",
        task: { type, config: { ...(meta?.defaultConfig ?? {}) } },
        next: null,
        position: { x, y },
      });
      setSelectedPhaseId(id);
    });
  }

  function deletePhase(id: string) {
    updateWf((next) => {
      next.phases = next.phases.filter((p) => p.id !== id);
      next.phases.forEach((p) => {
        if (p.retry_target === id) p.retry_target = null;
        if (p.next === id) p.next = null;
      });
    });
    if (selectedPhaseId === id) setSelectedPhaseId(null);
  }


  async function save() {
    if (!wf) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const saved = await api.putWorkflow(project.id, wf);
      setWf(saved);
      setDirty(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!confirm(t("confirm.reset_playbook"))) return;
    setBusy(true);
    setInfo(null);
    try {
      const def = await api.resetWorkflow(project.id);
      setWf(def);
      setDirty(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "calc(100vh - 240px)", minHeight: 500 }}>
      {!bannerDismissed && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "8px 14px", marginBottom: -4,
          background: "rgba(124, 58, 237, 0.06)",
          border: "1px solid rgba(124, 58, 237, 0.18)",
          borderRadius: 8, fontSize: 12, color: "var(--text-dim)",
        }}>
          <span style={{ fontSize: 16 }}>🎬</span>
          <span style={{ flex: 1 }}>
            <b style={{ color: "#7c3aed" }}>{t("banner.director_orchestrates")}</b>{" "}
            {t("banner.director_explains")}
          </span>
          <button
            onClick={() => {
              try { localStorage.setItem("ceo.banner.director.dismissed", "1"); } catch {}
              setBannerDismissed(true);
            }}
            style={{ fontSize: 11, alignSelf: "flex-start", marginTop: 2 }}
          >{t("banner.dismiss")}</button>
        </div>
      )}
      <SkillsPanel
        wf={wf}
        agentsById={agentsById}
        agents={project.agents}
        projectId={project.id}
        onSelect={(id) => setSelectedPhaseId(id)}
        onAdd={addPhase}
        onAddNew={() => setCreatingNewAgent(true)}
        onImportLibrary={() => setShowLibraryPicker(true)}
        onAgentsChanged={async () => { if (onChanged) await onChanged(); }}
      />
      <GatesPanel
        wf={wf}
        onSelect={(id) => setSelectedPhaseId(id)}
        onAddTask={addTaskPhase}
        onAddApproval={addApprovalPhase}
      />
      <NamedPlaybooksPanel
        wf={wf}
        agentsById={agentsById}
        onChange={(updater) => updateWf(updater)}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
        <button onClick={save} disabled={busy || !dirty} className={dirty ? "primary" : ""}>
          {busy ? t("common.saving") : dirty ? t("common.dirty") : t("common.saved")}
        </button>
        <button onClick={() => setShowTemplates(true)} disabled={busy}>{t("btn.apply_template")}</button>
        <button onClick={() => setShowSaveTemplate(true)} disabled={busy}>{t("btn.save_as_template")}</button>
        <button onClick={reset} disabled={busy}>{t("btn.reset_default")}</button>
        {info && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--green)" }}>{info}</span>}
        {err && <span style={{ fontSize: 11, color: "var(--red)" }}>{err}</span>}
      </div>


      <div className="settings-section" style={{ marginBottom: 0 }}>
        <h3>{t("settings.project_specifics")}</h3>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
          {t("settings.project_specifics_hint")}
        </div>
        <textarea
          value={wf.project_specifics ?? ""}
          onChange={(e) =>
            updateWf((next) => {
              next.project_specifics = e.target.value;
            })
          }
          rows={5}
          placeholder="e.g. Always use camelCase for JSON fields. Don't touch the legacy /v1 endpoints."
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
        />
      </div>

      {selected && (() => {
        const isAgentSkill = selected.kind === "agent" || !selected.kind;
        const selectedAgent = selected.agent_id ? agentsById.get(selected.agent_id) : null;
        const fromLibrary = !!selectedAgent?.template_key;
        // Tabs only for agent-kind skills. Gates/approvals are flat (the
        // distinction adds no value when there are only 2 sections).
        const tab = phaseModalTab;
        return (
        <div className="modal-backdrop" onClick={() => setSelectedPhaseId(null)}>
          <div className="phase-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="phase-modal-header">
              <h3>
                {getTaskKindForPhase(selected) !== null ? "Gate" : selected.kind === "approval" ? "Approval" : "Skill"}
                <code style={{ background: "var(--gray-soft)", padding: "2px 8px", borderRadius: 6, fontSize: 13 }}>{selected.id}</code>
                {fromLibrary && <span style={{
                  marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 8,
                  background: "rgba(14, 165, 233, 0.12)", color: "#0369a1",
                  border: "1px solid rgba(14, 165, 233, 0.3)", fontWeight: 500,
                }}>📚 Library</span>}
              </h3>
              <button className="x-btn" onClick={() => setSelectedPhaseId(null)} title="Close (Esc)">×</button>
            </div>
            {isAgentSkill && (
              <div className="phase-modal-tabs" role="tablist">
                <button
                  type="button" role="tab" aria-selected={tab === "skill"}
                  className={`phase-modal-tab ${tab === "skill" ? "active" : ""}`}
                  onClick={() => setPhaseModalTab("skill")}
                >Skill</button>
                <button
                  type="button" role="tab" aria-selected={tab === "agent"}
                  className={`phase-modal-tab ${tab === "agent" ? "active" : ""}`}
                  onClick={() => setPhaseModalTab("agent")}
                >Agent definition</button>
                <button
                  type="button" role="tab" aria-selected={tab === "advanced"}
                  className={`phase-modal-tab ${tab === "advanced" ? "active" : ""}`}
                  onClick={() => setPhaseModalTab("advanced")}
                >Advanced</button>
              </div>
            )}
            <div className="phase-modal-body">
            {(!isAgentSkill || tab === "skill") && (
            <div className="form-row">
              <label>id</label>
              <input
                value={selected.id}
                onChange={(e) => {
                  const newId = e.target.value;
                  if (!newId.match(/^[a-z0-9_-]+$/i)) return;
                  if (wf.phases.some((p) => p.id === newId && p.id !== selected.id)) return;
                  updateWf((next) => {
                    const p = next.phases.find((x) => x.id === selected.id)!;
                    p.id = newId;
                    next.phases.forEach((q) => {
                      if (q.retry_target === selected.id) q.retry_target = newId;
                      if (q.next === selected.id) q.next = newId;
                    });
                  });
                  setSelectedPhaseId(newId);
                }}
              />
            </div>
            )}
            {(!isAgentSkill || tab === "skill") && selected.kind !== "director" && (() => {
              const derived = deriveSkillCategory(selected, selectedAgent ? { name: selectedAgent.name, role: selectedAgent.role } : null);
              return (
                <div className="form-row">
                  <label>category</label>
                  <select
                    value={selected.category ?? ""}
                    onChange={(e) => updatePhase(selected.id, {
                      category: (e.target.value || undefined) as SkillCategory | undefined,
                    })}
                  >
                    <option value="">auto ({SKILL_CATEGORY_LABEL[derived]})</option>
                    {SKILL_CATEGORY_ORDER.map((c) => (
                      <option key={c} value={c}>{SKILL_CATEGORY_LABEL[c]}</option>
                    ))}
                  </select>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                    Capability group. Director sees skills grouped by category, not by edge order. Auto-derived from agent role/name when blank.
                  </div>
                </div>
              );
            })()}
            {selected.kind === "director" ? (
              <>
                <div className="form-row">
                  <label>budget (USD)</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={0.5}
                    value={selected.director?.budget_usd ?? 8}
                    onChange={(e) => updatePhase(selected.id, {
                      director: { ...(selected.director ?? {}), budget_usd: Number(e.target.value) },
                    })}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                    Hard cap on total Director + sub-agent cost. Run aborts when reached.
                  </div>
                </div>
                <div className="form-row">
                  <label>max iterations</label>
                  <input
                    type="number"
                    min={3}
                    max={50}
                    value={selected.director?.max_iterations ?? 12}
                    onChange={(e) => updatePhase(selected.id, {
                      director: { ...(selected.director ?? {}), max_iterations: Number(e.target.value) },
                    })}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                    Director decision turns before forced abort. Each turn ≈ one sub-agent dispatch + Director think.
                  </div>
                </div>
                <div className="form-row">
                  <label>project brief (appended to Director's system prompt)</label>
                  <textarea
                    value={selected.director?.project_brief ?? ""}
                    onChange={(e) => updatePhase(selected.id, {
                      director: { ...(selected.director ?? {}), project_brief: e.target.value || null },
                    })}
                    rows={5}
                    placeholder="e.g. PHP project with FrankenPHP. Tests run via composer ci in Docker. Lexik JWT for api auth, X-Internal-Token for plant-api. Default locale cs, fallback for de-DE."
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                  />
                </div>
                <div className="form-row">
                  <label>available sub-agents (comma-separated, blank = all)</label>
                  <input
                    value={(selected.director?.available_subagents ?? []).join(", ")}
                    onChange={(e) => {
                      const list = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                      updatePhase(selected.id, {
                        director: { ...(selected.director ?? {}), available_subagents: list.length === 0 ? undefined : list },
                      });
                    }}
                    placeholder="PHP Junior Coder, PHP Senior Coder, Reviewer, DevOps Engineer, Tester"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                    Names of project agents Director may dispatch. Empty = all (excluding CTO + Memory Curator).
                  </div>
                </div>
                <div style={{
                  marginTop: 8, padding: 8, fontSize: 11,
                  background: "rgba(124, 58, 237, 0.08)",
                  border: "1px solid rgba(124, 58, 237, 0.25)",
                  borderRadius: 6,
                  color: "#7c3aed",
                }}>
                  Director is a <b>terminal phase</b>. It handles its own iteration internally — no <code>next</code>, no <code>retry_target</code>. Run ends when Director calls mark_done / give_up / request_decompose, or budget/iterations exhausted.
                </div>
              </>
            ) : selected.kind === "approval" ? (
              <div className="form-row">
                <label>approval message (markdown, shown to the approver)</label>
                <textarea
                  value={selected.approval?.message ?? ""}
                  onChange={(e) => updatePhase(selected.id, {
                    approval: { message: e.target.value || null },
                  })}
                  rows={5}
                  placeholder="e.g. Review the diffs above. Approve to open a PR; reject to bounce back to Senior."
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                  When the run reaches this phase, it pauses with status=<code>awaiting_approval</code>.
                  You'll see Approve / Reject buttons in the run view. Reject bounces to <code>retry_target</code> (if set).
                </div>
              </div>
            ) : getTaskKindForPhase(selected) !== null ? (
              <TaskFormSection
                phase={selected}
                onChangeType={(type) => {
                  const meta = TASK_TYPES[type];
                  updatePhase(selected.id, {
                    kind: "task",
                    task: { type, config: meta?.defaultConfig ?? {} },
                    command: undefined,
                    working_dir: undefined,
                    timeout_sec: undefined,
                  });
                }}
                onChangeConfig={(config) => {
                  const type = getTaskKindForPhase(selected) ?? "shell";
                  updatePhase(selected.id, {
                    kind: "task",
                    task: { type, config },
                    command: undefined,
                    working_dir: undefined,
                    timeout_sec: undefined,
                  });
                }}
              />
            ) : (
              <>
                {tab === "skill" && (
                  <SkillAgentEditor
                    phase={selected}
                    project={project}
                    onPickAgent={(id) => updatePhase(selected.id, { agent_id: id })}
                    onAgentSaved={async () => { if (onChanged) await onChanged(); }}
                    view="picker"
                  />
                )}
                {tab === "agent" && (
                  <SkillAgentEditor
                    phase={selected}
                    project={project}
                    onPickAgent={(id) => updatePhase(selected.id, { agent_id: id })}
                    onAgentSaved={async () => { if (onChanged) await onChanged(); }}
                    view="definition"
                  />
                )}
              </>
            )}
            {tab === "skill" && getTaskKindForPhase(selected) === null && (
              <div className="form-row">
                <label>notes (appended to this skill's prompt every time it runs)</label>
                <textarea
                  value={selected.notes ?? ""}
                  onChange={(e) => updatePhase(selected.id, { notes: e.target.value || null })}
                  rows={5}
                  placeholder="e.g. Focus on security review for this phase."
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                />
              </div>
            )}
            {(!isAgentSkill || tab === "advanced") && getTaskKindForPhase(selected) === null && (
              <div className="form-row">
                <label>agent timeout (seconds, 0 = none, max 3600)</label>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  value={selected.timeout_sec ?? 0}
                  onChange={(e) => updatePhase(selected.id, { timeout_sec: Number(e.target.value) || undefined })}
                />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                  Hard cap on a single dispatch. If exceeded, sub-agent is killed and Director sees ok=false.
                </div>
              </div>
            )}
            </div>
            <div className="phase-modal-footer">
              <button
                className="danger"
                onClick={async () => {
                  if (fromLibrary) {
                    if (!confirm(
                      `Uninstall "${selectedAgent?.name ?? selected.id}" from this project?\n\n` +
                      `This skill was imported from the global library. Uninstalling removes it from THIS PROJECT ONLY — the library template stays in Admin → Skill templates and can be re-imported any time.\n\n` +
                      `(To delete the template for all projects, edit / reset it in Admin.)`,
                    )) return;
                    // Library skills are mirrors — also drop the local agent
                    // record so re-import works without a name collision.
                    // Order matters: phase first, then save, then delete agent.
                    const agentId = selectedAgent?.id;
                    deletePhase(selected.id);
                    setSelectedPhaseId(null);
                    if (agentId) {
                      try {
                        // Save the workflow so the server agrees the agent
                        // isn't referenced before we DELETE it.
                        const saved = await api.putWorkflow(project.id, {
                          ...wf,
                          phases: wf.phases.filter((p) => p.id !== selected.id),
                        });
                        setWf(saved);
                        setDirty(false);
                        await api.deleteAgent(project.id, agentId);
                        if (onChanged) await onChanged();
                        setInfo("Uninstalled from this project. Template stays in Admin.");
                      } catch (e: any) {
                        setErr(`Uninstall partial — agent record may need manual cleanup: ${e?.message ?? e}`);
                      }
                    }
                    return;
                  }
                  deletePhase(selected.id);
                  setSelectedPhaseId(null);
                }}
                title={fromLibrary
                  ? "Uninstall this library skill from this project. Template stays in Admin."
                  : "Delete this skill (and its agent if no other skill uses it)"}
              >
                {fromLibrary ? "Uninstall from project" : "Delete"}
              </button>
              <div style={{ flex: 1 }} />
              <button className="primary" onClick={() => setSelectedPhaseId(null)}>Done</button>
            </div>
          </div>
        </div>
        );
      })()}

      {showTemplates && (
        <TemplatePickerModal
          projectId={project.id}
          onClose={() => setShowTemplates(false)}
          onApplied={async () => {
            setShowTemplates(false);
            // Reload project + workflow.
            const fresh = await api.getWorkflow(project.id);
            setWf(fresh);
            setDirty(false);
            setInfo("Template applied. Reload the project (sidebar) to refresh agents list.");
          }}
        />
      )}
      {showSaveTemplate && (
        <SaveAsTemplateModal
          projectId={project.id}
          defaultKey={project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}
          defaultName={`${project.name} workflow`}
          onClose={() => setShowSaveTemplate(false)}
          onSaved={(t) => {
            setShowSaveTemplate(false);
            setInfo(`Saved template "${t.name}" (${t.key}).`);
          }}
        />
      )}
      {showLibraryPicker && (
        <LibrarySkillPicker
          templates={libraryTemplates}
          existingTemplateKeys={new Set(project.agents.map((a) => a.template_key).filter(Boolean) as string[])}
          existingNames={new Set(project.agents.map((a) => a.name))}
          onClose={() => setShowLibraryPicker(false)}
          onImport={async (key) => {
            try {
              await api.addAgentFromTemplate(project.id, key);
            } catch (e: any) {
              alert(`Import failed: ${e.message}`);
              return;
            }
            if (onChanged) await onChanged();
            // Refresh workflow to show the new auto-created phase.
            const fresh = await api.getWorkflow(project.id);
            setWf(fresh);
            setInfo(`📚 Imported "${key}" from library.`);
          }}
        />
      )}
      {creatingNewAgent && (
        <AgentForm
          mode="create"
          projectId={project.id}
          onClose={() => setCreatingNewAgent(false)}
          onSubmit={async (input) => {
            const created = await api.createAgent(project.id, input);
            if (onChanged) await onChanged();
            setCreatingNewAgent(false);
            // Auto-create a skill (phase) referencing the new agent so the
            // user lands in a coherent state — there's no point creating an
            // agent that's not used in the playbook.
            updateWf((next) => {
              const id = (input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")) || `skill_${next.phases.length + 1}`;
              const xs = next.phases.map((p) => p.position?.x ?? 0).concat([0]);
              const x = Math.max(...xs) + 240;
              next.phases.push({
                id: next.phases.some((p) => p.id === id) ? `${id}_${next.phases.length + 1}` : id,
                kind: "agent",
                agent_id: (created as Agent).id,
                next: null,
                position: { x, y: 240 },
              });
            });
            setInfo(`Created specialist "${input.name}" + skill. Save to persist.`);
          }}
        />
      )}
    </div>
  );
}

interface TemplatePickerModalProps {
  projectId: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}

function TemplatePickerModal({ projectId, onClose, onApplied }: TemplatePickerModalProps) {
  useEscClose(onClose);
  const [list, setList] = useState<WorkflowPreset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.listWorkflowPresets().then(setList).catch((e) => setErr(e.message));
  }, []);

  async function apply(key: string) {
    if (!confirm(t("confirm.apply_template"))) return;
    setBusy(key);
    setErr(null);
    try {
      const r = await api.applyWorkflowPreset(projectId, key);
      alert(
        `Applied: +${r.agents_added} agent(s), ${r.agents_existing} kept, ${r.phases} phases` +
        (r.teams_added ? `, +${r.teams_added} team(s)` : "") +
        (r.playbooks_added ? `, +${r.playbooks_added} playbook(s)` : "") +
        ".",
      );
      await onApplied();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function del(key: string) {
    if (!confirm(`Delete user template "${key}"?`)) return;
    setBusy(key);
    try {
      await api.deleteWorkflowPreset(key);
      setList((cur) => cur.filter((t) => t.key !== key));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h3>Playbook templates</h3>
        <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
          Apply a template to instantly clone a complete agent team + workflow into this project.
        </p>
        {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((t) => (
            <div key={t.key} className="repo-item" style={{ alignItems: "flex-start" }}>
              <div className="info" style={{ flex: 1 }}>
                <div className="name">
                  {t.name}{" "}
                  <span style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: t.source === "builtin" ? "var(--accent)" : "var(--green)",
                    color: "white",
                    marginLeft: 6,
                  }}>{t.source}</span>
                  <span style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: 8, fontFamily: "ui-monospace, monospace" }}>
                    {t.key}
                  </span>
                </div>
                <div className="url" style={{ marginTop: 4, color: "var(--text-dim)" }}>
                  {t.description}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  {t.agents.length} agent(s), {t.phases.length} phases
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="primary"
                  onClick={() => apply(t.key)}
                  disabled={busy !== null}
                >
                  {busy === t.key ? "..." : "Apply"}
                </button>
                {t.source === "user" && (
                  <button className="danger" onClick={() => del(t.key)} disabled={busy !== null}>
                    Delete
                  </button>
                )}
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

interface SaveAsTemplateModalProps {
  projectId: string;
  defaultKey: string;
  defaultName: string;
  onClose: () => void;
  onSaved: (t: WorkflowPreset) => void;
}

function SaveAsTemplateModal({ projectId, defaultKey, defaultName, onClose, onSaved }: SaveAsTemplateModalProps) {
  useEscClose(onClose);
  const [key, setKey] = useState(defaultKey);
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const t = await api.saveProjectAsTemplate(projectId, {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onSaved(t);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" role="dialog" aria-modal="true" style={{ width: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Save as playbook template</h3>
        <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
          Captures the current workflow + the agents it references. Saved as a JSON file in
          <code> ~/.ceo/templates/</code>; can be applied to other projects.
        </p>
        <div className="form-row">
          <label>Key (alphanumeric, used in filename)</label>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            pattern="[a-z0-9_-]+"
            required
          />
        </div>
        <div className="form-row">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="form-row">
          <label>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="What this team setup is for, who should use it..."
          />
        </div>
        {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
        <div className="form-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !key.trim() || !name.trim()}>
            {busy ? "Saving..." : "Save template"}
          </button>
        </div>
      </form>
    </div>
  );
}

