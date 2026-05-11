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
 *  registering it here (icon, color, palette label, default config, summary).
 *
 *  `category` controls which panel the task appears in:
 *    - "gate"      = validation check that gates Director's mark_done (CI, lint, security scan).
 *    - "connector" = side-effect integration (post a comment, transition issue, deploy).
 *                    Director never gates on connectors; they're wired via workflow.on_success / on_failure.
 */
const TASK_TYPES: Record<string, {
  label: string;
  icon: string;
  color: string;
  category: "gate" | "connector";
  defaultConfig: Record<string, unknown>;
  summary: (cfg: Record<string, unknown>) => string;
}> = {
  shell: {
    label: "Shell / CI",
    icon: "▷_",
    color: "#1e293b",
    category: "gate",
    defaultConfig: { command: "make ci", timeout_sec: 600 },
    summary: (c) => String(c.command ?? "").slice(0, 32),
  },
  telegram: {
    label: "Telegram",
    icon: "✈",
    color: "#0ea5e9",
    category: "connector",
    defaultConfig: {
      bot_token: "",
      chat_id: "",
      template: "{verdict_status} {ticket_key} {ticket_title}\n{verdict_summary}",
      on: "always",
      parse_mode: "Markdown",
    },
    summary: (c) => `→ chat ${String(c.chat_id ?? "?")}`,
  },
  github: {
    label: "GitHub",
    icon: "GH",
    color: "#24292f",
    category: "connector",
    defaultConfig: {
      default_repo: "",
      actions: [{ on: "always", action: "issue_comment", issue_number: 0, body: "Run {run_id} {verdict_status}: {verdict_summary}" }],
    },
    summary: (c) => {
      const n = Array.isArray(c.actions) ? (c.actions as unknown[]).length : 0;
      return `${n} action${n === 1 ? "" : "s"}`;
    },
  },
  jira: {
    label: "Jira",
    icon: "JR",
    color: "#0052cc",
    category: "connector",
    defaultConfig: {
      default_issue_key: "",
      actions: [{ on: "always", action: "comment", body: "Run {run_id} {verdict_status}: {verdict_summary}" }],
    },
    summary: (c) => {
      const n = Array.isArray(c.actions) ? (c.actions as unknown[]).length : 0;
      return `${n} action${n === 1 ? "" : "s"}`;
    },
  },
  ssh: {
    label: "SSH",
    icon: ">_",
    color: "#15803d",
    category: "connector",
    defaultConfig: {
      host: "",
      timeout_sec: 600,
      // port intentionally omitted — read from project secret ssh_default_port (or ssh's default 22)
      actions: [{ on: "always", command: "echo {ticket_key} {verdict_status}" }],
    },
    summary: (c) => {
      const host = String(c.host ?? "?");
      const n = Array.isArray(c.actions) ? (c.actions as unknown[]).length : 0;
      return `${host}: ${n} cmd${n === 1 ? "" : "s"}`;
    },
  },
  git_push: {
    label: "Git push",
    icon: "↑",
    color: "#7c2d12",
    category: "connector",
    defaultConfig: {
      remote: "origin",
      trigger: "success",
      strategy: "ff_only",
      commit_message_template: "",
    },
    summary: (c) => `push → ${String(c.remote ?? "origin")} · ${String(c.strategy ?? "ff_only")}`,
  },
};

/** Built-in presets that drop a pre-configured gate or connector into a
 *  workflow without typing the same boilerplate per project. Mirrors the
 *  "Import from library" UX for skills, but kept client-side: presets are
 *  static (compiled in), copied into the phase config, then editable per-
 *  project. Updating a preset definition here doesn't retroactively change
 *  existing phases — they're forks, not overlays. */
interface WorkflowPhasePreset {
  key: string;
  label: string;
  description: string;
  /** Group header in the picker UI. */
  category: "ci" | "git" | "approval" | "deploy";
  /** Concrete phase to drop into the workflow when picked. */
  phase: {
    id: string;
    kind: "task" | "approval";
    notes?: string;
    task?: { type: string; config: Record<string, unknown> };
    approval?: { message: string };
  };
}

const WORKFLOW_PHASE_PRESETS: WorkflowPhasePreset[] = [
  // ---- CI gates ------------------------------------------------------------
  {
    key: "ci_php_symfony",
    label: "PHP Symfony — composer ci",
    description: "Runs `composer ci` in the worktree. Assumes a composer script that wraps PHPStan + PHPUnit + lint.",
    category: "ci",
    phase: {
      id: "ci_gate",
      kind: "task",
      task: { type: "shell", config: { command: "composer ci", timeout_sec: 1800 } },
    },
  },
  {
    key: "ci_node_pnpm",
    label: "Node.js — pnpm test",
    description: "Runs `pnpm install --frozen-lockfile && pnpm test`. Use for Vite / Next / Nest projects.",
    category: "ci",
    phase: {
      id: "ci_gate",
      kind: "task",
      task: { type: "shell", config: { command: "pnpm install --frozen-lockfile && pnpm test", timeout_sec: 1800 } },
    },
  },
  {
    key: "ci_npm_test",
    label: "Node.js — npm test",
    description: "Runs `npm ci && npm test`. Use when project sticks with npm.",
    category: "ci",
    phase: {
      id: "ci_gate",
      kind: "task",
      task: { type: "shell", config: { command: "npm ci && npm test", timeout_sec: 1800 } },
    },
  },
  {
    key: "ci_docker_compose",
    label: "Docker Compose — make ci in app service",
    description: "`docker compose run --rm app make ci`. Use when CI runs inside a container (PHP, Python, etc.).",
    category: "ci",
    phase: {
      id: "ci_gate",
      kind: "task",
      task: { type: "shell", config: { command: "docker compose run --rm app make ci", timeout_sec: 1800 } },
    },
  },
  {
    key: "ci_python_pytest",
    label: "Python — pytest",
    description: "`pip install -e . && pytest`. Use for pip-based Python projects.",
    category: "ci",
    phase: {
      id: "ci_gate",
      kind: "task",
      task: { type: "shell", config: { command: "pip install -e . && pytest", timeout_sec: 1800 } },
    },
  },
  {
    key: "lint_phpstan",
    label: "Lint — PHPStan strict",
    description: "Runs `vendor/bin/phpstan analyse --no-progress`. Separate from CI for fast feedback.",
    category: "ci",
    phase: {
      id: "lint_gate",
      kind: "task",
      task: { type: "shell", config: { command: "vendor/bin/phpstan analyse --no-progress", timeout_sec: 600 } },
    },
  },
  {
    key: "lint_eslint",
    label: "Lint — ESLint strict",
    description: "Runs `pnpm exec eslint . --max-warnings=0`. Fails on any warning.",
    category: "ci",
    phase: {
      id: "lint_gate",
      kind: "task",
      task: { type: "shell", config: { command: "pnpm exec eslint . --max-warnings=0", timeout_sec: 600 } },
    },
  },

  // ---- Git push connectors -------------------------------------------------
  {
    key: "git_push_dev_squash",
    label: "Git push — development, squash with ticket title",
    description: "Pushes to `origin development` as one squashed commit named after the ticket. Recommended for clean git log.",
    category: "git",
    phase: {
      id: "git_push",
      kind: "task",
      task: {
        type: "git_push",
        config: {
          remote: "origin",
          trigger: "success",
          strategy: "squash",
          commit_message_template: "{ticket_title}",
        },
      },
    },
  },
  {
    key: "git_push_main_ff",
    label: "Git push — main, ff-only (preserves all commits)",
    description: "Pushes to `origin main` keeping every sub-agent commit. Suitable for projects without squash policy.",
    category: "git",
    phase: {
      id: "git_push",
      kind: "task",
      task: {
        type: "git_push",
        config: { remote: "origin", trigger: "success", strategy: "ff_only" },
      },
    },
  },
  {
    key: "git_push_dev_ff",
    label: "Git push — development, ff-only",
    description: "Pushes to `origin development` keeping all commits. Pair with manual MR/PR creation on GitLab/GitHub.",
    category: "git",
    phase: {
      id: "git_push",
      kind: "task",
      task: {
        type: "git_push",
        config: { remote: "origin", trigger: "success", strategy: "ff_only" },
      },
    },
  },

  // ---- Approval gates ------------------------------------------------------
  {
    key: "approval_before_destructive",
    label: "Approval — confirm before destructive migration",
    description: "Pauses the run so a human approves before a schema drop / data delete runs.",
    category: "approval",
    phase: {
      id: "approval_destructive",
      kind: "approval",
      approval: { message: "About to run a destructive migration. Review the diff and approve to proceed." },
    },
  },
  {
    key: "approval_before_prod",
    label: "Approval — confirm before production deploy",
    description: "Pauses the run so a human approves before a deploy to production.",
    category: "approval",
    phase: {
      id: "approval_prod",
      kind: "approval",
      approval: { message: "Ready to deploy to production. Approve when monitoring is clear." },
    },
  },
];

/** CI presets for the "shell" task — friendly wizard that generates a
 *  shell command instead of asking the user to write one. Picking "custom"
 *  drops back to a raw command field. */
const CI_PRESETS: { key: string; label: string; build: (cfg: Record<string, unknown>) => string }[] = [
  { key: "make", label: "Make target", build: (c) => `make ${String(c.target ?? "ci")}` },
  { key: "npm", label: "npm/pnpm script", build: (c) => `${String(c.runner ?? "npm")} run ${String(c.script ?? "test")}` },
  { key: "docker", label: "Docker Compose", build: (c) => `docker compose run --rm ${String(c.service ?? "app")} ${String(c.cmd ?? "make ci")}` },
  { key: "composer", label: "Composer script", build: (c) => `composer ${String(c.script ?? "test")}` },
  { key: "custom", label: "Custom shell", build: (c) => String(c.command ?? "") },
];

interface TaskFormProps {
  phase: WorkflowPhase;
  onChangeType: (type: string) => void;
  onChangeConfig: (config: Record<string, unknown>) => void;
  /** Connector forms get split across two tabs ("Connection" + "Actions").
   *  Pass which tab to render; "all" = render the full form (legacy / non-connector). */
  connectorTab?: "connection" | "actions" | "all";
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

function TaskFormSection({ phase, onChangeType, onChangeConfig, connectorTab = "all" }: TaskFormProps) {
  const type = getTaskKindForPhase(phase) ?? "shell";
  const config = getCurrentConfig(phase);
  const setField = (key: string, value: unknown) => onChangeConfig({ ...config, [key]: value });
  const [editing, setEditing] = useState<null | { field: string; lang: "bash" | "template"; title: string; hint?: string }>(null);
  const isConnector = TASK_TYPES[type]?.category === "connector";

  return (
    <>
      {/* Task type selector only for gates (where switching shell <-> approval makes
          sense). Connectors are picked by the "+ Přidat konektor" button — switching
          from GitHub to Jira mid-edit just throws away config, so we hide it. */}
      {!isConnector && (
        <div className="form-row">
          <label>task type</label>
          <select value={type} onChange={(e) => onChangeType(e.target.value)}>
            {Object.entries(TASK_TYPES).filter(([, m]) => m.category === "gate").map(([t, meta]) => (
              <option key={t} value={t}>
                {meta.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {type === "shell" && (
        <ShellPresetForm config={config} setField={setField} openEditor={(spec) => setEditing(spec)} phaseId={phase.id} />
      )}
      {type === "github" && (
        <GitHubForm config={config} setField={setField} openEditor={(spec) => setEditing(spec)} phaseId={phase.id} tab={connectorTab} />
      )}
      {type === "jira" && (
        <JiraForm config={config} setField={setField} openEditor={(spec) => setEditing(spec)} phaseId={phase.id} tab={connectorTab} />
      )}
      {type === "ssh" && (
        <SshForm config={config} setField={setField} openEditor={(spec) => setEditing(spec)} phaseId={phase.id} tab={connectorTab} />
      )}
      {type === "git_push" && (
        <>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10, padding: "8px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6 }}>
            Po dokončení runu pushne base branch každého repa projektu na zadaný remote. Pracuje pro GitLab i GitHub — používá git CLI nad existující remote konfigurací, žádné platform-specific API. Engine se postará o lokální merge worktree → base; tato akce jen pushne ven (případně přepíše merge na jeden squash commit).
          </div>
          <div className="form-row">
            <label>remote</label>
            <input
              value={String(config.remote ?? "origin")}
              onChange={(e) => setField("remote", e.target.value)}
              placeholder="origin"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>push when</label>
            <select
              value={String(config.trigger ?? "success")}
              onChange={(e) => setField("trigger", e.target.value)}
            >
              <option value="success">only on success (recommended)</option>
              <option value="always">always (even on failure — push partial work)</option>
              <option value="failure">only on failure (rare)</option>
            </select>
          </div>
          <div className="form-row">
            <label>strategy</label>
            <select
              value={String(config.strategy ?? "ff_only")}
              onChange={(e) => setField("strategy", e.target.value)}
            >
              <option value="ff_only">ff-only (zachová všechny sub-agent commits)</option>
              <option value="squash">squash (jeden commit s vlastní message)</option>
            </select>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              <b>ff-only:</b> ponechá 10+ drobných commitů od Junior/Senior. <b>squash:</b> všechno do jednoho commitu se zprávou níže — čistší git log na development.
            </div>
          </div>
          {String(config.strategy ?? "ff_only") === "squash" && (
            <div className="form-row">
              <label>commit message template</label>
              <input
                value={String(config.commit_message_template ?? "")}
                onChange={(e) => setField("commit_message_template", e.target.value)}
                placeholder="implement {ticket_title}"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
              />
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                Placeholders: <code>{"{ticket_key} {ticket_title} {project_name} {run_id} {verdict_summary} {verdict_status}"}</code>
              </div>
            </div>
          )}
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

// ---- Sub-forms for each task type ------------------------------------------

interface SubFormProps {
  config: Record<string, unknown>;
  setField: (key: string, value: unknown) => void;
  /** Top-level editor (used by single-field forms like ShellPresetForm).
   *  Multi-action forms manage their own editor state internally to support
   *  per-action `body` / `command` fields without leaking synthetic top-level keys. */
  openEditor: (spec: { field: string; lang: "bash" | "template"; title: string; hint?: string }) => void;
  phaseId: string;
  /** Connector forms render only the "Connection" or "Actions" section based
   *  on the active tab. Non-connector forms ignore this prop. */
  tab?: "connection" | "actions" | "all";
}

/** Mutator bundle for an action list inside a connector config. Each
 *  multi-action form (GitHub / Jira / SSH) consumes the same shape — extract
 *  the boilerplate into one hook so adding a connector means writing only
 *  the per-action UI, not the array plumbing. */
type ConnectorAction = Record<string, unknown>;

function useActionList(
  actions: ConnectorAction[],
  setField: (key: string, value: unknown) => void,
  newActionDefault: () => ConnectorAction,
) {
  const updateAll = (next: ConnectorAction[]) => setField("actions", next);
  return {
    update: (i: number, patch: ConnectorAction) =>
      updateAll(actions.map((a, j) => (j === i ? { ...a, ...patch } : a))),
    add: () => updateAll([...actions, newActionDefault()]),
    remove: (i: number) => updateAll(actions.filter((_, j) => j !== i)),
    move: (i: number, dir: -1 | 1) => {
      const j = i + dir;
      if (j < 0 || j >= actions.length) return;
      const next = [...actions];
      [next[i], next[j]] = [next[j]!, next[i]!];
      updateAll(next);
    },
  };
}

/** Local editor state for connector forms that need to edit one action's
 *  multi-line field (body, command). Wraps CodeEditorModal so each form
 *  manages its own modal independent of the parent. */
function useActionEditor() {
  const [editing, setEditing] = useState<null | { value: string; lang: "bash" | "template"; title: string; hint?: string; onSave: (next: string) => void }>(null);
  const open = (spec: { value: string; lang: "bash" | "template"; title: string; hint?: string; onSave: (next: string) => void }) => setEditing(spec);
  const close = () => setEditing(null);
  const node = editing ? (
    <CodeEditorModal
      title={editing.title}
      value={editing.value}
      language={editing.lang}
      hint={editing.hint}
      onClose={close}
      onSave={(next) => { editing.onSave(next); close(); }}
    />
  ) : null;
  return { open, node };
}

/** Infer which CI preset best matches an existing shell command. Used on
 *  first render so legacy phases land on a sensible preset, not "custom". */
function inferPreset(command: string): { preset: string; fields: Record<string, unknown> } {
  const c = command.trim();
  if (/^make\s+/.test(c)) return { preset: "make", fields: { target: c.replace(/^make\s+/, "") } };
  if (/^docker\s+compose\s+run\b/.test(c)) return { preset: "docker", fields: {} };
  if (/^(npm|pnpm|yarn)\s+(run\s+)?/.test(c)) {
    const m = c.match(/^(npm|pnpm|yarn)\s+(?:run\s+)?(\S+)/);
    return { preset: "npm", fields: { runner: m?.[1] ?? "npm", script: m?.[2] ?? "test" } };
  }
  if (/^composer\s+/.test(c)) return { preset: "composer", fields: { script: c.replace(/^composer\s+/, "") } };
  return { preset: "custom", fields: {} };
}

function ShellPresetForm({ config, setField, openEditor, phaseId }: SubFormProps) {
  const stored = String(config.__preset ?? "");
  const inferred = stored || inferPreset(String(config.command ?? "")).preset;
  const preset = inferred;
  // Show the preset-wizard UI only when user explicitly opted in (non-custom
  // preset stored, or expanded toggle). The 90% case is "type a command" —
  // global preset picker (📦 Použít preset) handles tech-stack templates.
  const [showWizard, setShowWizard] = useState(preset !== "custom");

  const updatePreset = (next: string) => {
    setField("__preset", next);
    if (next === "custom") return; // keep current command
    const builders: Record<string, () => string> = {
      make: () => `make ${String(config.target ?? "ci")}`,
      docker: () => `docker compose run --rm ${String(config.service ?? "app")} ${String(config.cmd ?? "make ci")}`,
      npm: () => `${String(config.runner ?? "npm")} run ${String(config.script ?? "test")}`,
      composer: () => `composer ${String(config.script ?? "test")}`,
    };
    const cmd = builders[next]?.() ?? "";
    if (cmd) setField("command", cmd);
  };

  // Update command whenever the preset's parametric fields change.
  const updatePresetField = (key: string, value: unknown) => {
    setField(key, value);
    const after = { ...config, [key]: value };
    if (preset === "make") setField("command", `make ${String(after.target ?? "ci")}`);
    else if (preset === "docker") setField("command", `docker compose run --rm ${String(after.service ?? "app")} ${String(after.cmd ?? "make ci")}`);
    else if (preset === "npm") setField("command", `${String(after.runner ?? "npm")} run ${String(after.script ?? "test")}`);
    else if (preset === "composer") setField("command", `composer ${String(after.script ?? "test")}`);
  };

  return (
    <>
      {showWizard ? (
        <div className="form-row">
          <label>preset</label>
          <select value={preset} onChange={(e) => updatePreset(e.target.value)}>
            {CI_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          <button type="button" onClick={() => { setShowWizard(false); updatePreset("custom"); }} style={{ marginTop: 6, fontSize: 11, padding: "2px 8px", background: "transparent", border: "1px dashed var(--border)", color: "var(--text-dim)" }}>
            ✕ Zrušit wizard, napsat příkaz ručně
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setShowWizard(true)} style={{ marginBottom: 10, fontSize: 11, padding: "4px 10px", background: "transparent", border: "1px dashed var(--border)", color: "var(--text-dim)" }}>
          📋 Použít wizard pro Make / npm / Docker / Composer
        </button>
      )}

      {showWizard && preset === "make" && (
        <div className="form-row">
          <label>make target</label>
          <input
            value={String(config.target ?? "ci")}
            onChange={(e) => updatePresetField("target", e.target.value)}
            placeholder="ci"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          />
        </div>
      )}

      {showWizard && preset === "npm" && (
        <>
          <div className="form-row">
            <label>runner</label>
            <select value={String(config.runner ?? "npm")} onChange={(e) => updatePresetField("runner", e.target.value)}>
              <option value="npm">npm</option>
              <option value="pnpm">pnpm</option>
              <option value="yarn">yarn</option>
            </select>
          </div>
          <div className="form-row">
            <label>script</label>
            <input
              value={String(config.script ?? "test")}
              onChange={(e) => updatePresetField("script", e.target.value)}
              placeholder="test | lint | typecheck"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
        </>
      )}

      {showWizard && preset === "docker" && (
        <>
          <div className="form-row">
            <label>service</label>
            <input
              value={String(config.service ?? "app")}
              onChange={(e) => updatePresetField("service", e.target.value)}
              placeholder="app"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          <div className="form-row">
            <label>command inside container</label>
            <input
              value={String(config.cmd ?? "make ci")}
              onChange={(e) => updatePresetField("cmd", e.target.value)}
              placeholder="make ci"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
        </>
      )}

      {showWizard && preset === "composer" && (
        <div className="form-row">
          <label>composer script</label>
          <input
            value={String(config.script ?? "test")}
            onChange={(e) => updatePresetField("script", e.target.value)}
            placeholder="test | lint"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          />
        </div>
      )}

      <div className="form-row">
        <label>{showWizard && preset !== "custom" ? "generated command" : "command"}</label>
        {showWizard && preset !== "custom" ? (
          <code style={{ background: "var(--gray-soft)", padding: "6px 10px", borderRadius: 4, fontSize: 12, display: "block" }}>
            {String(config.command ?? "")}
          </code>
        ) : (
          <CodePreviewButton
            value={String(config.command ?? "")}
            emptyLabel="(empty — click to write a shell command)"
            onClick={() => openEditor({
              field: "command",
              lang: "bash",
              title: `Edit shell command — ${phaseId}`,
              hint: "Runs via bash -lc in the run worktree. Exit 0 → next; non-zero → retry target.",
            })}
          />
        )}
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
  );
}

// ---- Multi-action connector forms ------------------------------------------

/** Normalize a connector config into a working { actions: [...] } shape so the
 *  UI always edits an array, even on legacy single-action phases. The action
 *  shape is widened to a generic record because the editor handles arbitrary
 *  per-connector keys (body, repo, transition_name, working_dir, ...). */

function ensureActions(
  config: Record<string, unknown>,
  legacyKeys: string[],
  defaultAction: ConnectorAction,
): { actions: ConnectorAction[] } {
  if (Array.isArray(config.actions)) {
    return { actions: config.actions as ConnectorAction[] };
  }
  // Lift legacy fields into a single action so existing phases keep working.
  const lifted: ConnectorAction = { ...defaultAction, on: defaultAction.on ?? "always" };
  for (const k of legacyKeys) {
    if (config[k] !== undefined) lifted[k] = config[k];
  }
  return { actions: [lifted] };
}

/** Reusable trigger dropdown shown on every action row. */
function TriggerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ fontSize: 12 }}>
      <option value="always">always</option>
      <option value="success">on success</option>
      <option value="failure">on failure</option>
    </select>
  );
}

interface ActionRowChromeProps {
  index: number;
  total: number;
  trigger: string;
  onChangeTrigger: (v: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}
function ActionRowChrome({ index, total, trigger, onChangeTrigger, onMoveUp, onMoveDown, onDelete, children }: ActionRowChromeProps) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8, background: "var(--bg-soft, #fafafa)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 14 }}>#{index + 1}</span>
        <TriggerSelect value={trigger} onChange={onChangeTrigger} />
        <div style={{ flex: 1 }} />
        <button onClick={onMoveUp} disabled={index === 0} title="Move up">↑</button>
        <button onClick={onMoveDown} disabled={index === total - 1} title="Move down">↓</button>
        <button onClick={onDelete} className="danger" title="Delete this action">×</button>
      </div>
      {children}
    </div>
  );
}

function GitHubForm({ config, setField, phaseId, tab = "all" }: SubFormProps) {
  const editor = useActionEditor();
  const { actions } = ensureActions(config, [], { on: "always", action: "issue_comment", issue_number: 0 });
  const list = useActionList(actions, setField, () => ({
    on: "always", action: "issue_comment", issue_number: 0, body: "Run {run_id} {verdict_status}: {verdict_summary}",
  }));
  const { update: updateAction, add: addAction, remove: removeAction, move: moveAction } = list;

  const showConnection = tab === "connection" || tab === "all";
  const showActions = tab === "actions" || tab === "all";

  return (
    <>
      {showConnection && (
        <div className="form-row">
          <label>default repo (owner/name)</label>
          <input
            value={String(config.default_repo ?? config.repo ?? "")}
            onChange={(e) => setField("default_repo", e.target.value)}
            placeholder="owner/repo (used when an action omits its own repo)"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          />
        </div>
      )}

      {showActions && (
      <div style={{ marginTop: 8 }}>
        {actions.map((a, i) => {
          const action = String(a.action ?? "issue_comment");
          return (
            <ActionRowChrome
              key={i}
              index={i}
              total={actions.length}
              trigger={String(a.on ?? "always")}
              onChangeTrigger={(v) => updateAction(i, { on: v })}
              onMoveUp={() => moveAction(i, -1)}
              onMoveDown={() => moveAction(i, 1)}
              onDelete={() => removeAction(i)}
            >
              <div className="form-row">
                <label>action</label>
                <select value={action} onChange={(e) => updateAction(i, { action: e.target.value })}>
                  <option value="issue_comment">Comment on issue / PR</option>
                  <option value="set_labels">Set labels (replaces existing)</option>
                  <option value="close_issue">Close issue / PR</option>
                </select>
              </div>
              <div className="form-row">
                <label>repo (optional override)</label>
                <input
                  value={String(a.repo ?? "")}
                  onChange={(e) => updateAction(i, { repo: e.target.value || undefined })}
                  placeholder="(uses default_repo above)"
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                />
              </div>
              <div className="form-row">
                <label>issue / PR number</label>
                <input
                  type="number"
                  min={1}
                  value={Number(a.issue_number ?? 0)}
                  onChange={(e) => updateAction(i, { issue_number: Number(e.target.value) })}
                />
              </div>
              {action === "issue_comment" && (
                <div className="form-row">
                  <label>comment body</label>
                  <CodePreviewButton
                    value={String(a.body ?? "")}
                    emptyLabel="(empty — click to write)"
                    onClick={() => editor.open({
                      value: String(a.body ?? ""),
                      lang: "template",
                      title: `Edit GitHub comment body — ${phaseId} action #${i + 1}`,
                      hint: "Placeholders: {ticket_key} {ticket_title} {project_name} {run_id} {verdict_summary} {verdict_status}",
                      onSave: (next) => updateAction(i, { body: next }),
                    })}
                  />
                </div>
              )}
              {action === "set_labels" && (
                <div className="form-row">
                  <label>labels (comma-separated)</label>
                  <input
                    value={Array.isArray(a.labels) ? (a.labels as string[]).join(", ") : ""}
                    onChange={(e) => updateAction(i, { labels: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                    placeholder="bug, automated, ready-for-review"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                  />
                </div>
              )}
            </ActionRowChrome>
          );
        })}
        <button onClick={addAction}>+ Add action</button>
      </div>
      )}

      {showConnection && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          Auth: project settings → Connector secrets → <code>github_token</code> (PAT with <code>repo</code> scope).
        </div>
      )}
      {showActions && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          All eligible actions fire automatically when the run terminates; the trigger filters which ones run.
        </div>
      )}
      {editor.node}
    </>
  );
}

function JiraForm({ config, setField, phaseId, tab = "all" }: SubFormProps) {
  const editor = useActionEditor();
  const { actions } = ensureActions(config, [], { on: "always", action: "comment" });
  const list = useActionList(actions, setField, () => ({
    on: "always", action: "comment", body: "Run {run_id} {verdict_status}: {verdict_summary}",
  }));
  const { update: updateAction, add: addAction, remove: removeAction, move: moveAction } = list;

  const showConnection = tab === "connection" || tab === "all";
  const showActions = tab === "actions" || tab === "all";

  return (
    <>
      {showConnection && (
        <div className="form-row">
          <label>default issue key</label>
          <input
            value={String(config.default_issue_key ?? config.issue_key ?? "")}
            onChange={(e) => setField("default_issue_key", e.target.value.toUpperCase())}
            placeholder="PROJ-123 (used when an action omits its own issue_key)"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          />
        </div>
      )}

      {showActions && (
      <div style={{ marginTop: 8 }}>
        {actions.map((a, i) => {
          const action = String(a.action ?? "comment");
          return (
            <ActionRowChrome
              key={i}
              index={i}
              total={actions.length}
              trigger={String(a.on ?? "always")}
              onChangeTrigger={(v) => updateAction(i, { on: v })}
              onMoveUp={() => moveAction(i, -1)}
              onMoveDown={() => moveAction(i, 1)}
              onDelete={() => removeAction(i)}
            >
              <div className="form-row">
                <label>action</label>
                <select value={action} onChange={(e) => updateAction(i, { action: e.target.value })}>
                  <option value="comment">Add comment</option>
                  <option value="transition">Transition issue (move to status)</option>
                </select>
              </div>
              <div className="form-row">
                <label>issue key (optional override)</label>
                <input
                  value={String(a.issue_key ?? "")}
                  onChange={(e) => updateAction(i, { issue_key: e.target.value.toUpperCase() || undefined })}
                  placeholder="(uses default_issue_key above)"
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                />
              </div>
              {action === "comment" && (
                <div className="form-row">
                  <label>comment body</label>
                  <CodePreviewButton
                    value={String(a.body ?? "")}
                    emptyLabel="(empty — click to write)"
                    onClick={() => editor.open({
                      value: String(a.body ?? ""),
                      lang: "template",
                      title: `Edit Jira comment body — ${phaseId} action #${i + 1}`,
                      hint: "Placeholders: {ticket_key} {ticket_title} {project_name} {run_id} {verdict_summary} {verdict_status}. Plain text — Jira renders Atlassian Document Format.",
                      onSave: (next) => updateAction(i, { body: next }),
                    })}
                  />
                </div>
              )}
              {action === "transition" && (
                <div className="form-row">
                  <label>transition name</label>
                  <input
                    value={String(a.transition_name ?? "")}
                    onChange={(e) => updateAction(i, { transition_name: e.target.value })}
                    placeholder="Done | In Review | Closed"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                  />
                </div>
              )}
            </ActionRowChrome>
          );
        })}
        <button onClick={addAction}>+ Add action</button>
      </div>
      )}

      {showConnection && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          Auth: project settings → Connector secrets → <code>jira_base_url</code> + <code>jira_email</code> + <code>jira_api_token</code>.
        </div>
      )}
      {showActions && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          Transitions are resolved by name (case-insensitive) at fire time.
        </div>
      )}
      {editor.node}
    </>
  );
}

function SshForm({ config, setField, phaseId, tab = "all" }: SubFormProps) {
  const editor = useActionEditor();
  const { actions } = ensureActions(config, [], { on: "always", command: "" });
  const list = useActionList(actions, setField, () => ({
    on: "always", command: "echo {ticket_key} {verdict_status}",
  }));
  const { update: updateAction, add: addAction, remove: removeAction, move: moveAction } = list;

  const showConnection = tab === "connection" || tab === "all";
  const showActions = tab === "actions" || tab === "all";

  return (
    <>
      {showConnection && (
        <>
          <div className="form-row">
            <label>host (override, volitelné)</label>
            <input
              value={String(config.host ?? "")}
              onChange={(e) => setField("host", e.target.value)}
              placeholder="user@host:port (jinak se použije ssh_default_target ze secrets)"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
              Cíl + klíč nastavíš v project settings → Connector secrets (<code>ssh_default_target</code>, <code>ssh_key_path</code>). Tady jen kdyby tahle fáze měla cílit jinam.
            </div>
          </div>
          <div className="form-row">
            <label>timeout (seconds, per command)</label>
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

      {showActions && (
      <div style={{ marginTop: 8 }}>
        {actions.map((a, i) => (
          <ActionRowChrome
            key={i}
            index={i}
            total={actions.length}
            trigger={String(a.on ?? "always")}
            onChangeTrigger={(v) => updateAction(i, { on: v })}
            onMoveUp={() => moveAction(i, -1)}
            onMoveDown={() => moveAction(i, 1)}
            onDelete={() => removeAction(i)}
          >
            <div className="form-row">
              <label>command</label>
              <CodePreviewButton
                value={String(a.command ?? "")}
                emptyLabel="(empty — click to write the remote command)"
                onClick={() => editor.open({
                  value: String(a.command ?? ""),
                  lang: "bash",
                  title: `Edit SSH command — ${phaseId} action #${i + 1}`,
                  hint: "Runs in the remote shell. Placeholders: {ticket_key} {ticket_title} {project_name} {run_id} {verdict_summary} {verdict_status}.",
                  onSave: (next) => updateAction(i, { command: next }),
                })}
              />
            </div>
            <div className="form-row">
              <label>working dir (optional)</label>
              <input
                value={String(a.working_dir ?? "")}
                onChange={(e) => updateAction(i, { working_dir: e.target.value || undefined })}
                placeholder="/var/www/app"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
              />
            </div>
          </ActionRowChrome>
        ))}
        <button onClick={addAction}>+ Add action</button>
      </div>
      )}

      {showConnection && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          Auth: project settings → Connector secrets → <code>ssh_key_path</code> (key-based auth required; password prompts disabled).
        </div>
      )}
      {editor.node}
    </>
  );
}



function clonePhase(p: WorkflowPhase): WorkflowPhase {
  return { ...p, position: p.position ? { ...p.position } : null };
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

/** Render one task/approval phase row. Used by both Gates and Connectors panels. */
function TaskPhaseRow({ phase, onSelect }: { phase: WorkflowPhase; onSelect: (id: string) => void }) {
  const taskType = phase.kind === "task" ? phase.task?.type : phase.kind === "approval" ? "approval" : "shell";
  const meta = TASK_TYPES[taskType ?? "shell"];
  const isApproval = phase.kind === "approval";
  return (
    <button
      key={phase.id}
      onClick={() => onSelect(phase.id)}
      className="row-card"
      style={{ width: "100%", textAlign: "left" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div>
          <span style={{
            display: "inline-block", width: 22, height: 22, lineHeight: "22px",
            textAlign: "center", borderRadius: 4, marginRight: 8,
            background: meta?.color ?? (isApproval ? "#f59e0b" : "#666"),
            color: "#fff", fontSize: 11,
          }}>{meta?.icon ?? (isApproval ? "⏸" : "?")}</span>
          <code style={{ background: "var(--gray-soft)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>{phase.id}</code>
          <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-dim)" }}>
            {isApproval ? "approval" : (meta?.label ?? taskType)}
          </span>
        </div>
      </div>
    </button>
  );
}

/**
 * Gates panel — validation gates that block Director's mark_done.
 * Includes shell/CI tasks and approval steps. Director-enforced ci_gate
 * lives here.
 */
function GatesPanel({
  wf,
  onSelect,
  onAddTask,
  onAddApproval,
  onImportPreset,
}: {
  wf: WorkflowDefinition;
  onSelect: (phaseId: string) => void;
  onAddTask: (type: string) => void;
  onAddApproval: () => void;
  onImportPreset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const gates = wf.phases.filter((p) => {
    if (p.kind === "approval") return true;
    if (p.kind === "command") return true; // legacy
    if (p.kind === "task") {
      const t = p.task?.type ?? "shell";
      return TASK_TYPES[t]?.category === "gate";
    }
    return false;
  });
  const gateTaskTypes = Object.entries(TASK_TYPES).filter(([, m]) => m.category === "gate");
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
      {gates.map((p) => <TaskPhaseRow key={p.id} phase={p} onSelect={onSelect} />)}
      <div style={{ display: "flex", gap: 6, marginTop: 10, position: "relative", flexWrap: "wrap" }}>
        <button onClick={onImportPreset} className="primary" title="Vyber z hotové sady CI / lint / approval presetů">
          📦 Použít preset
        </button>
        <button onClick={() => setAddOpen((o) => !o)}>+ {t("btn.add_gate")}</button>
        {addOpen && (
          <div className="wf-popover" style={{ position: "absolute", top: "100%", left: "auto", marginTop: 4, zIndex: 10 }}>
            {gateTaskTypes.map(([key, meta]) => (
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
 * Connectors panel — outbound integrations (GitHub, Jira, SSH, Telegram).
 * Side-effects only; never gate Director's mark_done. Wire them via
 * workflow.on_success / on_failure to fire after a run completes.
 */
function ConnectorsPanel({
  wf,
  onSelect,
  onAddTask,
  onImportPreset,
}: {
  wf: WorkflowDefinition;
  onSelect: (phaseId: string) => void;
  onAddTask: (type: string) => void;
  onImportPreset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const connectors = wf.phases.filter((p) => {
    if (p.kind !== "task") return false;
    const t = p.task?.type ?? "";
    return TASK_TYPES[t]?.category === "connector";
  });
  const connectorTaskTypes = Object.entries(TASK_TYPES).filter(([, m]) => m.category === "connector");

  return (
    <CollapsibleSection
      open={open}
      onToggle={() => setOpen((o) => !o)}
      title="Connectors"
      summary={`${connectors.length} ${connectors.length === 1 ? "integrace" : "integrací"} (Jira, GitHub, SSH, Telegram, Git push)`}
      icon="🔌"
    >
      {connectors.length === 0 && (
        <div style={{ color: "var(--text-dim)", padding: "8px 0" }}>
          Žádný konektor. Použij preset, nebo přidej Jira / GitHub / SSH / Git push abys reportoval výsledek runu navenek.
        </div>
      )}
      {connectors.map((p) => <TaskPhaseRow key={p.id} phase={p} onSelect={onSelect} />)}
      <div style={{ display: "flex", gap: 6, marginTop: 10, position: "relative", flexWrap: "wrap" }}>
        <button onClick={onImportPreset} className="primary" title="Vyber z hotové sady git_push / approval / CI presetů">
          📦 Použít preset
        </button>
        <button onClick={() => setAddOpen((o) => !o)}>+ Přidat konektor</button>
        {addOpen && (
          <div className="wf-popover" style={{ position: "absolute", top: "100%", left: "auto", marginTop: 4, zIndex: 10 }}>
            {connectorTaskTypes.map(([key, meta]) => (
              <button
                key={key}
                onClick={() => { onAddTask(key); setAddOpen(false); }}
              >
                <span className="pop-icon" style={{ background: meta.color }}>{meta.icon}</span>
                {meta.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, padding: 8, background: "var(--gray-soft)", borderRadius: 4 }}>
        Konektory se spustí automaticky při ukončení runu. Kdy přesně se vystřelí každá akce řídí trigger uvnitř (always / on success / on failure).
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
      {/* Hide the agent picker for library-linked skills — switching agent
          would silently break the "edits propagate via template" promise.
          User who wants a different agent must first detach (admin) or
          import a different library template. */}
      {showPicker && !fromLibrary && (
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
      {/* Allowed tools is power-user territory — most agents inherit a
       *  reasonable default. Tuck behind a `<details>` so the modal stays
       *  visually clean for the 99% case. Library-linked agents skip this
       *  block entirely (definition is read-only). */}
      {!fromLibrary && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--text-dim)", padding: "4px 0" }}>
            Pokročilé: omezit tool sadu
          </summary>
          <div className="form-row" style={{ marginTop: 6 }}>
            <label>Allowed tools (CSV)</label>
            <input
              value={toolsCsv}
              onChange={(e) => setToolsCsv(e.target.value)}
              placeholder="Read, Edit, Bash, Grep, Glob (prázdné = výchozí sada)"
            />
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
              Whitelist toolů co může agent používat. Prázdné = výchozí sada (Read, Edit, Bash, …). Nastav jen když chceš agenta omezit (např. Reviewer = jen Read/Grep).
            </div>
          </div>
        </details>
      )}
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

/** Built-in preset picker — mirrors LibrarySkillPicker UX but uses the
 *  client-side WORKFLOW_PHASE_PRESETS registry instead of a server-backed library.
 *  Presets are copied into the phase on import (no overlay) — user edits
 *  per-project after pick. */
function PresetPickerModal({
  filter,
  onClose,
  onPick,
}: {
  filter: WorkflowPhasePreset["category"][];
  onClose: () => void;
  onPick: (preset: WorkflowPhasePreset) => void;
}) {
  useEscClose(onClose);
  const visible = WORKFLOW_PHASE_PRESETS.filter((p) => filter.includes(p.category));
  const byCategory = visible.reduce<Record<string, WorkflowPhasePreset[]>>((acc, p) => {
    (acc[p.category] = acc[p.category] ?? []).push(p);
    return acc;
  }, {});
  const CATEGORY_META: Record<WorkflowPhasePreset["category"], { label: string; icon: string }> = {
    ci: { label: "CI & lint gates", icon: "🛡" },
    git: { label: "Git push", icon: "↑" },
    approval: { label: "Human approval", icon: "⏸" },
    deploy: { label: "Deploy & ops", icon: "🚀" },
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width: 720, maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>📦 Vyber preset</h3>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
          Hotové konfigurace pro běžné případy. Po importu si je můžeš upravit per-projekt — žádné live napojení na knihovnu, žádná synchronizace zpět.
        </div>
        {Object.entries(byCategory).map(([cat, presets]) => {
          const meta = CATEGORY_META[cat as WorkflowPhasePreset["category"]];
          return (
            <div key={cat} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 8 }}>
                {meta.icon} {meta.label}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {presets.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => onPick(p)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--bg-elevated)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{p.description}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>(žádné presety pro tuhle sekci)</div>
        )}
        <div className="form-actions">
          <button onClick={onClose}>Zavřít</button>
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
  /** Connector phases use their own two-tab layout (connection / actions)
   *  independent of the Skill modal's tabs. Reset alongside selectedPhaseId.
   *  Default to "connection" — credentials/host/repo come first; actions
   *  reference them. Opening the modal on Actions hid the port field for SSH
   *  users who didn't realise there was a Connection tab. */
  const [connectorTab, setConnectorTab] = useState<"connection" | "actions">("connection");
  useEffect(() => {
    setPhaseModalTab("skill");
    setConnectorTab("connection");
  }, [selectedPhaseId]);
  // Library picker — pulls global Skill templates from admin.
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  /** When non-null, opens the preset picker filtered to these categories. */
  const [presetPickerFilter, setPresetPickerFilter] = useState<WorkflowPhasePreset["category"][] | null>(null);
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

  /** Drop a built-in WorkflowPhasePreset into the workflow. Phase config is
   *  copied in (no live overlay to the preset definition — user can edit
   *  freely after import). If a phase with the same id already exists, append
   *  a suffix. */
  function addFromPreset(preset: WorkflowPhasePreset) {
    updateWf((next) => {
      const existingIds = new Set(next.phases.map((p) => p.id));
      let id = preset.phase.id;
      let suffix = 2;
      while (existingIds.has(id)) {
        id = `${preset.phase.id}_${suffix++}`;
      }
      const xs = next.phases.map((p) => p.position?.x ?? 0).concat([0]);
      const x = Math.max(...xs) + 240;
      const y = 120;
      next.phases.push({
        id,
        kind: preset.phase.kind,
        ...(preset.phase.notes ? { notes: preset.phase.notes } : {}),
        ...(preset.phase.task ? { task: { type: preset.phase.task.type, config: { ...preset.phase.task.config } } } : {}),
        ...(preset.phase.approval ? { approval: { ...preset.phase.approval } } : {}),
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
        onImportPreset={() => setPresetPickerFilter(["ci", "approval"])}
      />
      <ConnectorsPanel
        wf={wf}
        onSelect={(id) => setSelectedPhaseId(id)}
        onAddTask={addTaskPhase}
        onImportPreset={() => setPresetPickerFilter(["git", "deploy"])}
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
                {(() => {
                  const tk = getTaskKindForPhase(selected);
                  if (tk !== null) {
                    const meta = TASK_TYPES[tk];
                    return meta?.category === "connector" ? "Connector" : "Gate";
                  }
                  return selected.kind === "approval" ? "Approval" : "Skill";
                })()}
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
              // Connectors aren't part of the Director's skill graph (they
              // auto-fire at terminal). Hide the category dropdown — it adds
              // confusion without functional value.
              const tk = getTaskKindForPhase(selected);
              if (tk && TASK_TYPES[tk]?.category === "connector") return null;
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
            ) : getTaskKindForPhase(selected) !== null ? (() => {
              const tk = getTaskKindForPhase(selected) ?? "shell";
              const isConnector = TASK_TYPES[tk]?.category === "connector";
              const taskForm = (
                <TaskFormSection
                  phase={selected}
                  connectorTab={isConnector ? connectorTab : "all"}
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
              );
              if (!isConnector) return taskForm;
              // Single-action connectors (git_push, telegram) have no per-action
              // list — render the form without the Připojení/Akce split because
              // there's literally nothing under "Akce" to show.
              const hasActionList = selected.task?.type === "github"
                || selected.task?.type === "jira"
                || selected.task?.type === "ssh";
              if (!hasActionList) return taskForm;
              return (
                <>
                  <div className="phase-modal-tabs" role="tablist" style={{ marginTop: 4 }}>
                    <button
                      type="button" role="tab" aria-selected={connectorTab === "connection"}
                      className={`phase-modal-tab ${connectorTab === "connection" ? "active" : ""}`}
                      onClick={() => setConnectorTab("connection")}
                    >Připojení</button>
                    <button
                      type="button" role="tab" aria-selected={connectorTab === "actions"}
                      className={`phase-modal-tab ${connectorTab === "actions" ? "active" : ""}`}
                      onClick={() => setConnectorTab("actions")}
                    >Akce</button>
                  </div>
                  {taskForm}
                </>
              );
            })() : (
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
      {presetPickerFilter && (
        <PresetPickerModal
          filter={presetPickerFilter}
          onClose={() => setPresetPickerFilter(null)}
          onPick={(preset) => {
            addFromPreset(preset);
            setPresetPickerFilter(null);
            setInfo(`📦 Imported preset "${preset.label}".`);
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

