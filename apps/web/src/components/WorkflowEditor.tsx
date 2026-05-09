import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
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

const ROLE_COLOR: Record<AgentRole, string> = {
  coder: "#7c5cff",
  reviewer: "#d29922",
  tester: "#3fb950",
};

interface PhaseNodeData {
  phase: WorkflowPhase;
  agent: Agent | undefined;
  active: ActiveRunSummary[];
  queued: Ticket[];
}

const ROLE_GLYPH: Record<AgentRole, string> = {
  coder: "</>",
  reviewer: "✓",
  tester: "▶",
};

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

function PhaseNode({ data, selected }: NodeProps<PhaseNodeData>) {
  const { phase, agent, active, queued } = data;
  const taskType = getTaskKindForPhase(phase);
  const isTask = taskType !== null;
  const isApproval = phase.kind === "approval";
  const isDirector = phase.kind === "director";
  const taskMeta = taskType ? TASK_TYPES[taskType] : null;
  const role = agent?.role ?? "coder";

  // For legacy command phases, config lives on the phase itself; for task phases, in task.config.
  const taskConfig: Record<string, unknown> = phase.kind === "task"
    ? (phase.task?.config ?? {})
    : phase.kind === "command"
    ? { command: phase.command, working_dir: phase.working_dir, timeout_sec: phase.timeout_sec }
    : {};

  const taskSummary = taskMeta && isTask ? taskMeta.summary(taskConfig) : "";

  const tooltip = active.length > 0
    ? `${active.length} active:\n` + active.map((a) => `${a.ticket_key ?? a.ticket_id.slice(0, 6)} ${a.ticket_title}`).join("\n")
    : isDirector
    ? `director · ${phase.id}\nbudget $${phase.director?.budget_usd ?? 8} · max ${phase.director?.max_iterations ?? 12} iter`
    : isApproval
    ? `approval · ${phase.id}\n${phase.approval?.message ?? "(no message)"}`
    : isTask
    ? `${taskType} · ${phase.id}\n${taskSummary}`
    : `${agent?.name ?? "(missing)"} · ${phase.id}`;

  // Task / approval / director phases are valid without an agent; only flag agent phases as "missing".
  const isMissing = !isTask && !isApproval && !isDirector && !agent;

  return (
    <div className="n8n-node-wrap" title={tooltip}>
      <div
        className={`n8n-node ${selected ? "selected" : ""} ${isMissing ? "missing" : ""} ${(isTask || isApproval || isDirector) ? "command" : ""}`}
      >
        <Handle id="in" type="target" position={Position.Left} className="n8n-handle" />
        <div
          className="n8n-node-icon"
          style={{ background: isDirector ? "#7c3aed" : isApproval ? "#f59e0b" : (taskMeta ? taskMeta.color : (ROLE_COLOR[role] ?? "#666")) }}
        >
          {isDirector ? "🎬" : isApproval ? "⏸" : (taskMeta ? taskMeta.icon : (ROLE_GLYPH[role] ?? "?"))}
        </div>
        <Handle id="out" type="source" position={Position.Right} className="n8n-handle" />
        {/* Hidden bottom handles for backward (retry) edges — they keep retries
            looping cleanly under the main flow. */}
        <Handle
          id="retry-out"
          type="source"
          position={Position.Bottom}
          className="n8n-handle n8n-handle-retry"
          style={{ left: "70%" }}
        />
        <Handle
          id="retry-in"
          type="target"
          position={Position.Bottom}
          className="n8n-handle n8n-handle-retry"
          style={{ left: "30%" }}
        />

        {active.length > 0 && (
          <div className="phase-active">
            <span className="phase-active-pulse" />
            <span className="phase-active-count">{active.length}</span>
            <span className="phase-active-keys">
              {active.slice(0, 2).map((a) => a.ticket_key ?? a.ticket_id.slice(0, 4)).join(", ")}
              {active.length > 2 ? "…" : ""}
            </span>
          </div>
        )}
        {queued.length > 0 && (
          <div
            className="phase-queued"
            title={queued.map((t) => `${t.ticket_key ?? t.id.slice(0, 6)} ${t.title}`).join("\n")}
          >
            <span className="phase-queued-count">{queued.length}</span>
            <span className="phase-queued-label">queued</span>
          </div>
        )}
      </div>
      <div className="n8n-node-label">{phase.id}</div>
      {isDirector ? (
        <div
          className="n8n-node-sublabel"
          style={{ fontSize: 10, opacity: 0.75, color: "#7c3aed", fontWeight: 600 }}
        >
          Director · ${phase.director?.budget_usd ?? 8} · {phase.director?.max_iterations ?? 12}t
        </div>
      ) : isApproval ? (
        <div
          className="n8n-node-sublabel"
          style={{ fontSize: 10, opacity: 0.75, color: "#92400e" }}
        >
          Approval gate
        </div>
      ) : isTask ? (
        <div
          className="n8n-node-sublabel"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 10, opacity: 0.75 }}
        >
          <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.5, marginRight: 4, opacity: 0.7 }}>
            Gate
          </span>
          {taskMeta?.label ?? taskType}
          {taskSummary ? ` · ${taskSummary}` : ""}
        </div>
      ) : (
        agent && (
          <div className="n8n-node-sublabel">
            <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.5, marginRight: 4, opacity: 0.65, fontSize: 9 }}>
              Skill
            </span>
            {agent.name}
          </div>
        )
      )}
    </div>
  );
}

const nodeTypes = { phase: PhaseNode };

/**
 * Custom retry edge: a deep U-curve that dips below the main flow row.
 * Both endpoints are expected to sit on the bottom of their nodes.
 */
function RetryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  label,
  labelStyle,
  labelBgStyle,
}: EdgeProps) {
  // Force a consistent dip depth so even short retries arc nicely.
  const horizontalSpan = Math.abs(targetX - sourceX);
  const dipDepth = Math.max(80, Math.min(160, horizontalSpan * 0.35));
  const dipY = Math.max(sourceY, targetY) + dipDepth;

  // Cubic bezier: start point, control1 below source, control2 below target, end point.
  const path = `M ${sourceX} ${sourceY} C ${sourceX} ${dipY}, ${targetX} ${dipY}, ${targetX} ${targetY}`;

  // Label placement at the dip's lowest point.
  const labelX = (sourceX + targetX) / 2;
  const labelY = dipY - 4;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: (labelBgStyle as any)?.fill ?? "rgba(255,255,255,0.95)",
              padding: "1px 6px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              color: (labelStyle as any)?.fill ?? "#f85149",
              pointerEvents: "all",
              border: "1px solid #fee2e2",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Bypass edge: an upward arc for forward edges that need to cross the main
 * flow without overlapping the nodes in between (e.g. devops_review → closer
 * jumps over tester / ci_gate). Mirrors RetryEdge but bows upward.
 */
function BypassEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  label,
  labelStyle,
  labelBgStyle,
}: EdgeProps) {
  // Orthogonal step routing: horizontal at sourceY, drop vertically near the
  // target, horizontal into target's left handle. Two rounded corners.
  // The horizontal segment runs at sourceY, naturally clearing nodes that sit
  // on a different lane.
  const radius = 12;
  const dropPad = 36; // horizontal distance from target to where we drop
  const goingRight = targetX >= sourceX;
  const turnX = goingRight ? targetX - dropPad : targetX + dropPad;
  const goingDown = targetY >= sourceY;

  // Build path with two 90° rounded corners. Sign of `r` adjusts for direction.
  const r1 = goingRight ? radius : -radius;        // first turn (horizontal → vertical)
  const r2 = goingDown ? radius : -radius;         // first turn vertical sign
  const r3 = goingRight ? radius : -radius;        // second turn (vertical → horizontal)

  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${turnX - r1} ${sourceY}`,
    `Q ${turnX} ${sourceY}, ${turnX} ${sourceY + r2}`,
    `L ${turnX} ${targetY - r2}`,
    `Q ${turnX} ${targetY}, ${turnX + r3} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");

  // Label: middle of the horizontal segment at sourceY, slightly above.
  const labelX = (sourceX + turnX) / 2;
  const labelY = sourceY - 8;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: (labelBgStyle as any)?.fill ?? "rgba(255,255,255,0.95)",
              padding: "1px 6px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              color: (labelStyle as any)?.fill ?? "#3b82f6",
              pointerEvents: "all",
              border: "1px solid rgba(59, 130, 246, 0.3)",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { retry: RetryEdge, bypass: BypassEdge };

function buildFlow(
  wf: WorkflowDefinition,
  agentsById: Map<string, Agent>,
  activeByPhase: Map<string, ActiveRunSummary[]>,
  queuedTickets: Ticket[],
): { nodes: Node<PhaseNodeData>[]; edges: Edge[] } {
  // Director is the implicit orchestrator and does not appear on the canvas —
  // the user designs the playbook (phases) and Director runs above it.
  const visiblePhases = wf.phases.filter((p) => p.kind !== "director");
  const entryPhaseId = visiblePhases[0]?.id;
  const nodes: Node<PhaseNodeData>[] = visiblePhases.map((p, i) => ({
    id: p.id,
    type: "phase",
    position: p.position ?? { x: 60 + i * 240, y: 120 },
    data: {
      phase: p,
      agent: p.agent_id ? agentsById.get(p.agent_id) : undefined,
      active: activeByPhase.get(p.id) ?? [],
      queued: p.id === entryPhaseId ? queuedTickets : [],
    },
  }));

  // Map phase id → position so we can detect "skipping" forward edges that
  // need a bypass arc (source far from target with other nodes in between).
  const posById = new Map<string, { x: number; y: number }>();
  for (const n of nodes) posById.set(n.id, n.position);
  function needsBypassArc(srcId: string, tgtId: string): boolean {
    const s = posById.get(srcId);
    const t = posById.get(tgtId);
    if (!s || !t) return false;
    const xMin = Math.min(s.x, t.x);
    const xMax = Math.max(s.x, t.x);
    if (xMax - xMin < 360) return false; // adjacent nodes — straight is fine
    // Are there any other nodes lying horizontally between s and t whose y is
    // close to either endpoint? Those are the ones the line would visually
    // cross. Use bypass if so.
    for (const n of nodes) {
      if (n.id === srcId || n.id === tgtId) continue;
      if (n.position.x > xMin + 60 && n.position.x < xMax - 60) {
        if (Math.abs(n.position.y - s.y) < 80 || Math.abs(n.position.y - t.y) < 80) {
          return true;
        }
      }
    }
    return false;
  }

  const edges: Edge[] = [];
  for (const p of visiblePhases) {
    if (p.next) {
      const bypass = needsBypassArc(p.id, p.next);
      // "next" is an advisory hint to Director (common follow-up), not enforced
      // sequencing. Render dotted/lighter to communicate that Director may
      // skip, reorder, or revisit. Retry edges (red dashed) and routes stay
      // strong because they encode escalation rules Director respects.
      edges.push({
        id: `next-${p.id}-${p.next}`,
        type: bypass ? "bypass" : "default",
        source: p.id,
        sourceHandle: "out",
        target: p.next,
        targetHandle: "in",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#93c5fd" },
        style: { stroke: "#93c5fd", strokeWidth: 1.5, strokeDasharray: "4 3" },
        deletable: true,
        data: { kind: "next" },
      });
    }
    if (p.retry_target) {
      edges.push({
        id: `retry-${p.id}-${p.retry_target}`,
        type: "retry",
        source: p.id,
        sourceHandle: "retry-out",
        target: p.retry_target,
        targetHandle: "retry-in",
        label: `↩ ${p.max_attempts ?? 2}`,
        animated: true,
        style: { stroke: "#f85149", strokeDasharray: "6 4", strokeWidth: 2 },
        labelStyle: { fill: "#f85149", fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: "rgba(255,255,255,0.95)" },
        labelBgPadding: [4, 2] as [number, number],
        markerEnd: { type: MarkerType.ArrowClosed, color: "#f85149" },
        deletable: true,
        data: { kind: "retry" },
      });
    }
    if (p.routes) {
      for (const [key, target] of Object.entries(p.routes)) {
        if (!target) continue;
        edges.push({
          id: `route-${p.id}-${key}-${target}`,
          type: "default",
          source: p.id,
          sourceHandle: "out",
          target,
          targetHandle: "in",
          label: key,
          animated: true,
          style: { stroke: "#d29922", strokeDasharray: "4 3", strokeWidth: 2 },
          labelStyle: { fill: "#d29922", fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: "rgba(255,255,255,0.95)" },
          labelBgPadding: [4, 2] as [number, number],
          markerEnd: { type: MarkerType.ArrowClosed, color: "#d29922" },
          deletable: true,
          data: { kind: "route", routeKey: key },
        });
      }
    }
  }
  return { nodes, edges };
}

function clonePhase(p: WorkflowPhase): WorkflowPhase {
  return { ...p, position: p.position ? { ...p.position } : null };
}

/**
 * Compute clean grid positions via BFS over forward edges (next + route).
 * Phases reachable only via a `route` (i.e. fork branches like Architect)
 * are placed on a parallel lane above the main flow.
 */
function autoArrange(
  wf: WorkflowDefinition,
  agentsById?: Map<string, Agent>,
): Map<string, { x: number; y: number }> {
  const X_STEP = 180;
  const X_OFFSET = 80;
  const LANE_HEIGHT = 140;
  const LANE_TOP = 60;

  const phaseById = new Map(wf.phases.map((p) => [p.id, p]));

  // Group phases by capability category — each category becomes a horizontal
  // swimlane. Within a lane, BFS level on `next` edges drives X position.
  const cat = (p: WorkflowPhase): SkillCategory => {
    const a = p.agent_id ? agentsById?.get(p.agent_id) : null;
    return deriveSkillCategory(p, a ? { name: a.name, role: a.role } : null);
  };

  const phasesByCategory = new Map<SkillCategory, WorkflowPhase[]>();
  for (const p of wf.phases) {
    if (p.kind === "director") continue; // hidden
    const c = cat(p);
    if (!phasesByCategory.has(c)) phasesByCategory.set(c, []);
    phasesByCategory.get(c)!.push(p);
  }

  // BFS over `next` from entry to compute X levels; phases not reached pile
  // at level 0 of their lane.
  const level = new Map<string, number>();
  const entry = wf.phases.find((p) => p.kind !== "director")?.id;
  if (entry) {
    level.set(entry, 0);
    const queue = [entry];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const p = phaseById.get(id);
      if (!p) continue;
      const fwd: string[] = [];
      if (p.next) fwd.push(p.next);
      if (p.routes) for (const t of Object.values(p.routes)) if (t) fwd.push(t);
      for (const t of fwd) {
        const nl = (level.get(id) ?? 0) + 1;
        const cur = level.get(t);
        if (cur === undefined || cur < nl) {
          level.set(t, nl);
          queue.push(t);
        }
      }
    }
  }
  for (const p of wf.phases) if (!level.has(p.id)) level.set(p.id, 0);

  const positions = new Map<string, { x: number; y: number }>();
  // Determine lane Y per category: only categories that have phases get a
  // lane, in the canonical SKILL_CATEGORY_ORDER.
  const activeCats = SKILL_CATEGORY_ORDER.filter((c) => (phasesByCategory.get(c)?.length ?? 0) > 0);
  const laneY = new Map<SkillCategory, number>();
  activeCats.forEach((c, i) => laneY.set(c, LANE_TOP + i * LANE_HEIGHT));

  for (const [c, list] of phasesByCategory) {
    const y = laneY.get(c) ?? LANE_TOP;
    // Group within lane by level; if multiple phases share a level, stack them.
    const byLevel = new Map<number, WorkflowPhase[]>();
    for (const p of list) {
      const lv = level.get(p.id) ?? 0;
      byLevel.set(lv, [...(byLevel.get(lv) ?? []), p]);
    }
    for (const [lv, group] of byLevel) {
      const x = X_OFFSET + lv * X_STEP;
      group.forEach((p, i) => {
        positions.set(p.id, { x, y: y + i * 60 });
      });
    }
  }
  return positions;
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
 * Teams panel — capability groupings of agents. Director sees teams as a
 * separate axis from skills ("which team handles this?").
 */
function TeamsPanel({
  wf,
  agents,
  onChange,
}: {
  wf: WorkflowDefinition;
  agents: Agent[];
  onChange: (updater: (next: WorkflowDefinition) => void) => void;
}) {
  // Closed by default so the playbook tab doesn't open as a wall of panels.
  // The Skills panel above is the one that's open on first visit.
  const [open, setOpen] = useState(false);
  // null = closed; "new" = create mode; <id> = edit existing.
  const [editing, setEditing] = useState<null | "new" | string>(null);
  const teams = wf.teams ?? [];
  const editingTeam = typeof editing === "string" && editing !== "new"
    ? teams.find((tm) => tm.id === editing) ?? null
    : null;

  return (
    <CollapsibleSection
      open={open}
      onToggle={() => setOpen((o) => !o)}
      title={t("section.teams.title")}
      summary={t(teams.length === 1 ? "section.teams.summary_one" : "section.teams.summary_many", { count: teams.length })}
      icon="👥"
    >
      {teams.length === 0 && (
        <div style={{ color: "var(--text-dim)", padding: "8px 0" }}>
          {t("section.teams.empty")}
        </div>
      )}
      <TeamsFlowDiagram
        teams={teams}
        playbooks={wf.playbooks ?? []}
        onCardClick={(id) => setEditing(id)}
        onAddClick={() => setEditing("new")}
      />
      {editing && (
        <TeamEditModal
          mode={editing === "new" ? "create" : "edit"}
          initial={editingTeam}
          agents={agents}
          existingIds={teams.map((tm) => tm.id)}
          onClose={() => setEditing(null)}
          onSave={(team) => {
            onChange((next) => {
              if (!next.teams) next.teams = [];
              const idx = next.teams.findIndex((tm) => tm.id === team.id);
              if (idx >= 0) next.teams[idx] = team;
              else next.teams.push(team);
            });
            setEditing(null);
          }}
          onDelete={editing !== "new" ? () => {
            onChange((next) => { next.teams = (next.teams ?? []).filter((tm) => tm.id !== editing); });
            setEditing(null);
          } : undefined}
        />
      )}
    </CollapsibleSection>
  );
}

/**
 * TeamEditModal — single-purpose dialog for creating or editing a team.
 * Replaces the old inline form (which fought with the flow diagram for
 * attention). Members picked via chip toggles; auto-generates a stable id
 * from the name on create.
 */
function TeamEditModal({
  mode,
  initial,
  agents,
  existingIds,
  onClose,
  onSave,
  onDelete,
}: {
  mode: "create" | "edit";
  initial: Team | null;
  agents: Agent[];
  existingIds: string[];
  onClose: () => void;
  onSave: (team: Team) => void;
  onDelete?: () => void;
}) {
  useEscClose(onClose);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState<SkillCategory | "">(initial?.category ?? "");
  const [memberNames, setMemberNames] = useState<string[]>(initial?.agent_names ?? []);

  function genId(fromName: string): string {
    const base = fromName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "team";
    if (!existingIds.includes(base)) return base;
    let n = 2;
    while (existingIds.includes(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  const canSave = name.trim().length > 0;

  function save() {
    if (!canSave) return;
    onSave({
      id: initial?.id ?? genId(name),
      name: name.trim(),
      description: description.trim() || undefined,
      category: category || undefined,
      agent_names: memberNames,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal" role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(620px, 95vw)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{mode === "create" ? t("team.modal.new") : t("team.modal.edit", { name: initial?.name ?? "" })}</h3>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: 20, cursor: "pointer", color: "var(--text-dim)" }}
            title="Close (Esc)"
          >×</button>
        </div>
        <div className="form-row">
          <label>{t("team.modal.name")}</label>
          <input
            value={name}
            placeholder={t("team.modal.name_placeholder")}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-row">
          <label>{t("team.modal.category")}</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as SkillCategory | "")}>
            <option value="">{t("team.modal.no_category")}</option>
            {SKILL_CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>{SKILL_CATEGORY_LABEL[c]}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>{t("team.modal.description")}</label>
          <input
            value={description}
            placeholder={t("team.modal.description_placeholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>{t("team.modal.members", { count: memberNames.length })}</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 8, background: "var(--bg)", borderRadius: 6, border: "1px solid var(--border)" }}>
            {agents.map((a) => {
              const member = memberNames.includes(a.name);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setMemberNames(
                    member
                      ? memberNames.filter((n) => n !== a.name)
                      : [...memberNames, a.name],
                  )}
                  style={{
                    fontSize: 12, padding: "4px 10px", borderRadius: 14,
                    background: member ? "#7c3aed" : "var(--bg-elev)",
                    color: member ? "#fff" : "var(--text)",
                    border: `1px solid ${member ? "#7c3aed" : "var(--border)"}`,
                  }}
                >
                  <span style={{ marginRight: 4, opacity: 0.8 }}>{ROLE_GLYPH[a.role] ?? "·"}</span>
                  {a.name}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 16 }}>
          <div>
            {onDelete && (
              <button
                className="danger"
                onClick={() => { if (confirm(t("confirm.delete_team", { name: initial?.name ?? "" }))) onDelete(); }}
              >{t("team.modal.delete")}</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose}>{t("common.cancel")}</button>
            <button className="primary" onClick={save} disabled={!canSave}>
              {mode === "create" ? t("team.modal.create") : t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * TeamsFlowDiagram — renders teams as a horizontal flow with arrows showing
 * the typical work transitions between teams.
 *
 * The arrows are inferred from named Playbooks: each consecutive pair of
 * steps (step[i] → step[i+1]) becomes a directional handoff from the team
 * owning step[i]'s agent to the team owning step[i+1]'s agent. Aggregating
 * across all Playbooks gives "this is how work flows in this project."
 */
function TeamsFlowDiagram({
  teams,
  playbooks,
  onCardClick,
  onAddClick,
}: {
  teams: Team[];
  playbooks: Playbook[];
  onCardClick?: (id: string) => void;
  onAddClick?: () => void;
}) {
  // Sort teams in canonical category order.
  const sorted = useMemo(
    () => [...teams].sort((a, b) => {
      const ai = SKILL_CATEGORY_ORDER.indexOf(a.category ?? "general");
      const bi = SKILL_CATEGORY_ORDER.indexOf(b.category ?? "general");
      return ai - bi;
    }),
    [teams],
  );

  return (
    <div style={{
      padding: "14px 12px",
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      overflowX: "auto",
    }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
        {t("team.flow.title")}
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 0, minWidth: "fit-content" }}>
        {sorted.map((team, i) => (
          <div key={team.id} style={{ display: "flex", alignItems: "center" }}>
            <TeamCard team={team} onClick={onCardClick ? () => onCardClick(team.id) : undefined} />
            {i < sorted.length - 1 && (
              <div style={{
                fontSize: 18, color: "var(--text-dim)",
                padding: "0 10px", alignSelf: "center",
              }}>→</div>
            )}
          </div>
        ))}
        {onAddClick && (
          <div style={{ display: "flex", alignItems: "center" }}>
            {sorted.length > 0 && (
              <div style={{
                fontSize: 18, color: "var(--text-dim)",
                padding: "0 10px", alignSelf: "center", opacity: 0.5,
              }}>→</div>
            )}
            <button
              onClick={onAddClick}
              title="Add team"
              style={{
                flex: "0 0 auto", minWidth: 100, minHeight: 90,
                padding: 10,
                background: "transparent",
                border: "2px dashed var(--border)",
                borderRadius: 10,
                color: "var(--text-dim)",
                fontSize: 13, cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
              }}
            >
              <span style={{ fontSize: 24 }}>+</span>
              <span style={{ fontSize: 11 }}>{t("team.flow.add")}</span>
            </button>
          </div>
        )}
      </div>
      {playbooks.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-dim)" }}>
          <span style={{ marginRight: 8 }}>{t("team.flow.recipes")}</span>
          {playbooks.map((pb, i) => (
            <span key={pb.name} style={{
              display: "inline-block", padding: "2px 8px", borderRadius: 10,
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              marginRight: 6, marginBottom: 4,
            }}>
              {pb.name} <span style={{ opacity: 0.6 }}>· {t("team.flow.steps", { count: pb.steps.length })}</span>
              {i < playbooks.length - 1 ? "" : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamCard({
  team,
  onClick,
}: {
  team: Team;
  onClick?: () => void;
}) {
  const cat = team.category ?? "general";
  // Single source of truth for category color is in CSS (var(--cat-*)) so
  // any tweak there flows through every chip / pill / lane / flow chip.
  const color = `var(--cat-${cat})`;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      title={onClick ? "Click to edit" : undefined}
      style={{
      flex: "0 0 auto",
      minWidth: 160, maxWidth: 200,
      padding: 10,
      background: "var(--bg-elev)",
      border: `2px solid ${color}`,
      borderRadius: 10,
      position: "relative",
      textAlign: "left",
      cursor: onClick ? "pointer" : "default",
      transition: "transform 80ms ease",
    }}
      onMouseEnter={onClick ? (e) => { (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)"; } : undefined}
      onMouseLeave={onClick ? (e) => { (e.currentTarget as HTMLElement).style.transform = ""; } : undefined}
    >
      <div style={{
        position: "absolute", top: -8, left: 10,
        background: "var(--bg)", padding: "0 6px",
        fontSize: 10, color, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: 0.5,
      }}>
        {SKILL_CATEGORY_LABEL[cat as SkillCategory] ?? cat}
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{team.name}</div>
      {team.description && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 6, lineHeight: 1.3 }}>
          {team.description.length > 70 ? team.description.slice(0, 70) + "…" : team.description}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {team.agent_names.map((n) => (
          <span key={n} style={{
            fontSize: 10, padding: "1px 6px", borderRadius: 8,
            background: `color-mix(in srgb, ${color} 10%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
          }}>{n}</span>
        ))}
        {team.agent_names.length === 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>no members</span>
        )}
      </div>
    </Tag>
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

interface ToolbarProps {
  busy: boolean;
  dirty: boolean;
  info: string | null;
  err: string | null;
  onAddAgent: () => void;
  onAddTask: (type: string) => void;
  onAddApproval: () => void;
  onAutoArrange: () => void;
  onAlignRows: () => void;
  onDistribute: () => void;
  onResetDefault: () => void;
  onApplyTemplate: () => void;
  onSaveAsTemplate: () => void;
  onSave: () => void;
}

function WorkflowFloatingToolbar(props: ToolbarProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Close popovers on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target as globalThis.Node;
      if (addOpen && addRef.current && !addRef.current.contains(t)) setAddOpen(false);
      if (layoutOpen && layoutRef.current && !layoutRef.current.contains(t)) setLayoutOpen(false);
      if (moreOpen && moreRef.current && !moreRef.current.contains(t)) setMoreOpen(false);
    }
    if (addOpen || layoutOpen || moreOpen) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
    return undefined;
  }, [addOpen, layoutOpen, moreOpen]);

  return (
    <div className="wf-toolbar">
      <div className="wf-tb-group">
        <div className="wf-popover-host" ref={addRef}>
          <button onClick={() => { setAddOpen((o) => !o); setLayoutOpen(false); setMoreOpen(false); }} disabled={props.busy}>
            + Add ▾
          </button>
          {addOpen && (
            <div className="wf-popover">
              <button onClick={() => { props.onAddAgent(); setAddOpen(false); }}>
                <span className="pop-icon" style={{ background: "#6366f1" }}>{"</>"}</span>
                Agent (AI)
              </button>
              {Object.entries(TASK_TYPES).map(([type, meta]) => (
                <button key={type} onClick={() => { props.onAddTask(type); setAddOpen(false); }}>
                  <span className="pop-icon" style={{ background: meta.color }}>{meta.icon}</span>
                  {meta.label}
                </button>
              ))}
              <button onClick={() => { props.onAddApproval(); setAddOpen(false); }}>
                <span className="pop-icon" style={{ background: "#f59e0b" }}>⏸</span>
                Approval gate
              </button>
            </div>
          )}
        </div>
        <span className="divider" />
        <div className="wf-popover-host" ref={layoutRef}>
          <button onClick={() => { setLayoutOpen((o) => !o); setAddOpen(false); setMoreOpen(false); }} disabled={props.busy}>
            ⤧ Layout ▾
          </button>
          {layoutOpen && (
            <div className="wf-popover">
              <button onClick={() => { props.onAutoArrange(); setLayoutOpen(false); }}>⤧ Auto-arrange</button>
              <button onClick={() => { props.onAlignRows(); setLayoutOpen(false); }}>⇆ Align rows</button>
              <button onClick={() => { props.onDistribute(); setLayoutOpen(false); }}>↔ Distribute</button>
            </div>
          )}
        </div>
      </div>

      <div className="wf-tb-group">
        {props.info && (
          <span className="wf-status" title={props.info}>
            <span className="dot" /> {props.info.length > 32 ? props.info.slice(0, 32) + "…" : props.info}
          </span>
        )}
        {props.err && (
          <span className="wf-status dirty" title={props.err} style={{ color: "var(--red)" }}>
            <span className="dot" style={{ background: "#dc2626" }} /> {props.err.length > 40 ? props.err.slice(0, 40) + "…" : props.err}
          </span>
        )}
        <span className={`wf-status ${props.dirty ? "dirty" : ""}`}>
          <span className="dot" /> {props.dirty ? "Unsaved" : "Saved"}
        </span>
        <span className="divider" />
        <div className="wf-popover-host" ref={moreRef}>
          <button onClick={() => { setMoreOpen((o) => !o); setAddOpen(false); setLayoutOpen(false); }} disabled={props.busy}>
            ⋯
          </button>
          {moreOpen && (
            <div className="wf-popover" style={{ right: 0, left: "auto" }}>
              <button onClick={() => { props.onApplyTemplate(); setMoreOpen(false); }}>Apply template…</button>
              <button onClick={() => { props.onSaveAsTemplate(); setMoreOpen(false); }} disabled={props.busy || props.dirty}>
                Save as template…
              </button>
              <button onClick={() => { props.onResetDefault(); setMoreOpen(false); }}>Reset to default</button>
            </div>
          )}
        </div>
        <button className="primary" onClick={props.onSave} disabled={props.busy || !props.dirty}>
          {props.busy ? "…" : props.dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}

export function WorkflowEditor({ project, tickets, onChanged }: Props) {
  useLang(); // re-render on language change
  const [wf, setWf] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<Node<PhaseNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRunSummary[]>([]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [showLegacyGraph, setShowLegacyGraph] = useState(false);
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

  // Track dragging so we don't repeatedly write positions to wf during a drag.
  const draggingNodeId = useRef<string | null>(null);

  const agentsById = useMemo(
    () => new Map(project.agents.map((a) => [a.id, a])),
    [project.agents],
  );

  useEffect(() => {
    api
      .getWorkflow(project.id)
      .then((w) => {
        setWf(w);
        setDirty(false);
      })
      .catch((e) => setErr(e.message));
  }, [project.id]);

  // Rebuild nodes/edges when wf, agents, active-runs, or queued backlog change.
  useEffect(() => {
    if (!wf) return;
    const activeByPhase = new Map<string, ActiveRunSummary[]>();
    for (const r of activeRuns) {
      if (!r.current_phase_id) continue;
      const list = activeByPhase.get(r.current_phase_id) ?? [];
      list.push(r);
      activeByPhase.set(r.current_phase_id, list);
    }
    const queued = (tickets ?? []).filter((t) => t.status === "backlog");
    const flow = buildFlow(wf, agentsById, activeByPhase, queued);
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [wf, agentsById, activeRuns, tickets]);

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

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Apply visual changes immediately so dragging is smooth.
      setNodes((nds) => applyNodeChanges(changes, nds));
      // Track when a drag starts.
      for (const c of changes) {
        if (c.type === "position" && c.dragging) draggingNodeId.current = c.id;
      }
    },
    [],
  );

  const onNodeDragStop = useCallback((_: any, node: Node) => {
    draggingNodeId.current = null;
    updateWf((next) => {
      const p = next.phases.find((x) => x.id === node.id);
      if (p) p.position = { x: node.position.x, y: node.position.y };
    });
  }, [updateWf]);

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Visual sync.
      setEdges((eds) => applyEdgeChanges(changes, eds));
      // Apply removals to wf.
      const removed = changes.filter((c) => c.type === "remove") as Array<Extract<EdgeChange, { type: "remove" }>>;
      if (removed.length === 0) return;
      const removedIds = new Set(removed.map((r) => r.id));
      updateWf((next) => {
        for (const e of edges) {
          if (!removedIds.has(e.id)) continue;
          const data = e.data as any;
          const kind = data?.kind;
          const src = next.phases.find((x) => x.id === e.source);
          if (!src) continue;
          if (kind === "next") src.next = null;
          else if (kind === "retry") src.retry_target = null;
          else if (kind === "route" && data?.routeKey && src.routes) {
            const { [data.routeKey]: _drop, ...rest } = src.routes;
            src.routes = Object.keys(rest).length > 0 ? rest : null;
          }
        }
      });
    },
    [edges, updateWf],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target) {
        setInfo("A phase can't 'next' to itself.");
        return;
      }
      updateWf((next) => {
        const src = next.phases.find((x) => x.id === conn.source);
        if (src) src.next = conn.target;
      });
      setInfo(`Wired ${conn.source} → ${conn.target}. (To set a retry edge, use the side panel's "retry target".)`);
    },
    [updateWf],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      const kind = (oldEdge.data as any)?.kind ?? "next";
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target && kind !== "retry") {
        setInfo("A phase can't 'next' to itself.");
        return;
      }
      updateWf((next) => {
        // Clear old assignment.
        const oldSrc = next.phases.find((x) => x.id === oldEdge.source);
        if (oldSrc) {
          if (kind === "retry") oldSrc.retry_target = null;
          else oldSrc.next = null;
        }
        // Apply new.
        const newSrc = next.phases.find((x) => x.id === conn.source);
        if (newSrc) {
          if (kind === "retry") {
            newSrc.retry_target = conn.target;
            if (!newSrc.max_attempts) newSrc.max_attempts = 2;
          } else {
            newSrc.next = conn.target;
          }
        }
      });
    },
    [updateWf],
  );

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

  function movePhase(id: string, delta: -1 | 1) {
    updateWf((next) => {
      const i = next.phases.findIndex((p) => p.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= next.phases.length) return;
      [next.phases[i], next.phases[j]] = [next.phases[j]!, next.phases[i]!];
    });
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
      <TeamsPanel
        wf={wf}
        agents={project.agents}
        onChange={(updater) => updateWf(updater)}
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
        <label style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={showLegacyGraph}
            onChange={(e) => setShowLegacyGraph(e.target.checked)}
          />
          {t("common.show_legacy_graph")}
        </label>
        {info && <span style={{ fontSize: 11, color: "var(--green)" }}>{info}</span>}
        {err && <span style={{ fontSize: 11, color: "var(--red)" }}>{err}</span>}
      </div>

      {showLegacyGraph && (
      <div className="wf-canvas-wrap" style={{ minHeight: 500 }}>
        <WorkflowFloatingToolbar
          busy={busy}
          dirty={dirty}
          info={info}
          err={err}
          onAddAgent={addPhase}
          onAddTask={addTaskPhase}
          onAddApproval={addApprovalPhase}
          onAutoArrange={() => {
            const positions = autoArrange(wf!, agentsById);
            updateWf((next) => {
              next.phases.forEach((p) => {
                const pos = positions.get(p.id);
                if (pos) p.position = pos;
              });
            });
            setInfo("Auto-arranged. Save to persist.");
          }}
          onAlignRows={() => {
            const LANES = [80, 240];
            const snap20 = (n: number) => Math.round(n / 20) * 20;
            const nearestLane = (y: number) =>
              LANES.reduce((best, lane) =>
                Math.abs(lane - y) < Math.abs(best - y) ? lane : best,
              LANES[0]!);
            updateWf((next) => {
              next.phases.forEach((p) => {
                const pos = p.position ?? { x: 60, y: 240 };
                p.position = { x: snap20(pos.x), y: nearestLane(pos.y) };
              });
            });
            setInfo("Aligned to lanes. Save to persist.");
          }}
          onDistribute={() => {
            updateWf((next) => {
              const sorted = [...next.phases].sort(
                (a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0),
              );
              const lanes = new Map<number, typeof sorted>();
              for (const p of sorted) {
                const y = p.position?.y ?? 240;
                lanes.set(y, [...(lanes.get(y) ?? []), p]);
              }
              for (const [y, items] of lanes) {
                items.forEach((p, i) => {
                  const target = next.phases.find((x) => x.id === p.id)!;
                  target.position = { x: 60 + i * 180, y };
                });
              }
            });
            setInfo("Distributed evenly within lanes. Save to persist.");
          }}
          onResetDefault={reset}
          onApplyTemplate={() => setShowTemplates(true)}
          onSaveAsTemplate={() => setShowSaveTemplate(true)}
          onSave={save}
        />
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, width: "100%", height: "100%" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            snapToGrid
            snapGrid={[20, 20]}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_, n) => setSelectedPhaseId(n.id)}
            onPaneClick={() => setSelectedPhaseId(null)}
            onConnect={onConnect}
            onReconnect={onReconnect}
            nodesDraggable
            nodesConnectable
            edgesUpdatable
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background color="#d8dde6" gap={20} size={1} />
            <Controls />
          </ReactFlow>
        </div>
        <div className="wf-tip">
          Drag from a node's right handle to the next phase's left handle to set the main flow.
          Retry edges (<span style={{ color: "#f85149" }}>red dashed</span>) and routes
          (<span style={{ color: "#d29922" }}>amber dashed</span>) are configured by clicking a node.
          Click any edge + Delete to disconnect.
        </div>
      </div>
      )}

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
            {(!isAgentSkill || tab === "advanced") && (
            <details
              style={{ marginTop: 12, padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6 }}
              open={isAgentSkill && tab === "advanced"}
            >
              <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-dim)" }}>
                ▸ Graph hints (advisory — only visible to Director when planning)
              </summary>
              <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "6px 0 10px" }}>
                These are hints Director sees as "common follow-up" / "on-fail escalation" / conditional routing.
                Director respects retry/routes more than next, and can override any of them. Useful when you want
                to push a default ordering; safe to leave empty in most cases.
              </div>
              <div className="form-row">
                <label>common follow-up</label>
                <select
                  value={selected.next ?? ""}
                  onChange={(e) => updatePhase(selected.id, { next: e.target.value || null })}
                >
                  <option value="">(none)</option>
                  {wf.phases
                    .filter((p) => p.id !== selected.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} ({getTaskKindForPhase(p) ?? (p.agent_id ? agentsById.get(p.agent_id)?.role ?? "?" : "?")})
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-row">
                <label>on-fail escalate to</label>
                <select
                  value={selected.retry_target ?? ""}
                  onChange={(e) => updatePhase(selected.id, { retry_target: e.target.value || null })}
                >
                  <option value="">(none)</option>
                  {wf.phases
                    .filter((p) => p.id !== selected.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} ({getTaskKindForPhase(p) ?? (p.agent_id ? agentsById.get(p.agent_id)?.role ?? "?" : "?")})
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-row">
                <label>max attempts (legacy retry budget; Director ignores)</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={selected.max_attempts ?? 2}
                  onChange={(e) => updatePhase(selected.id, { max_attempts: Number(e.target.value) })}
                />
              </div>
              {getTaskKindForPhase(selected) === null && (
                <div className="form-row">
                  <label>conditional routes (verdict.route → phase) — legacy</label>
                  <RoutesEditor
                    phase={selected}
                    phases={wf.phases}
                    onChange={(routes) => updatePhase(selected.id, { routes })}
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button onClick={() => movePhase(selected.id, -1)} style={{ fontSize: 11 }}>↑ Up</button>
                <button onClick={() => movePhase(selected.id, 1)} style={{ fontSize: 11 }}>↓ Down</button>
                <button
                  onClick={() => updatePhase(selected.id, { position: null })}
                  title="Forget the saved canvas position; auto-layout will re-place it."
                  style={{ fontSize: 11 }}
                >Reset graph position</button>
              </div>
            </details>
            )}
            </div>
            <div className="phase-modal-footer">
              <button
                className="danger"
                onClick={() => {
                  if (fromLibrary) {
                    if (!confirm(`Remove "${selectedAgent?.name ?? selected.id}" from this project?\n\nThis only un-imports the skill from the project. The library template stays in Admin and can be re-imported anytime.`)) return;
                  }
                  deletePhase(selected.id);
                  setSelectedPhaseId(null);
                }}
                title={fromLibrary ? "Un-import this library skill from the project. Template stays in Admin." : "Delete this skill (and its agent if no other skill uses it)"}
              >
                {fromLibrary ? "Remove from project" : "Delete"}
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

interface RoutesEditorProps {
  phase: WorkflowPhase;
  phases: WorkflowPhase[];
  onChange: (routes: Record<string, string> | null) => void;
}

function RoutesEditor({ phase, phases, onChange }: RoutesEditorProps) {
  const entries = Object.entries(phase.routes ?? {});
  const others = phases.filter((p) => p.id !== phase.id);

  function update(idx: number, key: string, value: string) {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i === idx) {
        if (key) next[key] = value;
      } else {
        next[k] = v;
      }
    });
    onChange(Object.keys(next).length > 0 ? next : null);
  }

  function add() {
    const next: Record<string, string> = { ...(phase.routes ?? {}) };
    let key = "newRoute";
    let i = 1;
    while (key in next) key = `newRoute${i++}`;
    next[key] = others[0]?.id ?? "";
    onChange(next);
  }

  function remove(key: string) {
    const next = { ...(phase.routes ?? {}) };
    delete next[key];
    onChange(Object.keys(next).length > 0 ? next : null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {entries.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>(no routes)</div>
      )}
      {entries.map(([key, target], i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 4 }}>
          <input
            value={key}
            placeholder="route key (e.g. architect)"
            onChange={(e) => update(i, e.target.value, target)}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
          />
          <select
            value={target}
            onChange={(e) => update(i, key, e.target.value)}
          >
            {others.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
          <button type="button" className="danger" onClick={() => remove(key)}>×</button>
        </div>
      ))}
      <button type="button" onClick={add} disabled={others.length === 0}>+ Add route</button>
    </div>
  );
}
