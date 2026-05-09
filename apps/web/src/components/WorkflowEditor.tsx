import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ProjectWithRepos,
  SkillCategory,
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
import { CodeEditorModal } from "./CodeEditorModal";

interface Props {
  project: ProjectWithRepos;
  tickets?: Ticket[];
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

export function WorkflowEditor({ project, tickets }: Props) {
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
      const next: WorkflowDefinition = {
        phases: cur.phases.map(clonePhase),
        project_specifics: cur.project_specifics ?? null,
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
    if (!confirm("Reset playbook to default (one skill per agent role)?")) return;
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
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "8px 14px", marginBottom: -4,
        background: "rgba(124, 58, 237, 0.06)",
        border: "1px solid rgba(124, 58, 237, 0.18)",
        borderRadius: 8, fontSize: 12, color: "var(--text-dim)",
      }}>
        <span style={{ fontSize: 16 }}>🎬</span>
        <span>
          <b style={{ color: "#7c3aed" }}>Director orchestrates this playbook.</b>{" "}
          You design the library of <b>skills</b> (AI steps) and <b>gates</b> (deterministic checks);
          Director picks which to run, in what order, based on the ticket.
          Solid arrows are escalation rules Director respects; dotted arrows are common follow-ups (advisory).
        </span>
      </div>
      <div className="wf-canvas-wrap">
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

      <div className="settings-section" style={{ marginBottom: 0 }}>
        <h3>Project specifics for this playbook</h3>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
          Markdown injected into <em>every</em> agent's prompt during runs of this project.
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

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelectedPhaseId(null)}>
          <div className="phase-modal" onClick={(e) => e.stopPropagation()}>
            <div className="phase-modal-header">
              <h3>
                Phase
                <code style={{ background: "var(--gray-soft)", padding: "2px 8px", borderRadius: 6, fontSize: 13 }}>{selected.id}</code>
                <span className={`kind-pill ${getTaskKindForPhase(selected) !== null ? "task" : "agent"}`}>
                  {getTaskKindForPhase(selected) ?? "agent"}
                </span>
              </h3>
              <button className="x-btn" onClick={() => setSelectedPhaseId(null)} title="Close (Esc)">×</button>
            </div>
            <div className="phase-modal-body">
            <div className="form-row">
              <label>type</label>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className={selected.kind !== "approval" && getTaskKindForPhase(selected) === null ? "primary" : ""}
                  onClick={() => updatePhase(selected.id, {
                    kind: "agent",
                    agent_id: selected.agent_id ?? project.agents[0]?.id,
                    task: undefined,
                    approval: undefined,
                    command: undefined,
                    working_dir: undefined,
                    timeout_sec: undefined,
                  })}
                  style={{ flex: 1 }}
                >
                  Agent
                </button>
                <button
                  type="button"
                  className={selected.kind !== "approval" && getTaskKindForPhase(selected) !== null ? "primary" : ""}
                  onClick={() => {
                    const existingType = getTaskKindForPhase(selected);
                    const type = existingType ?? "shell";
                    const meta = TASK_TYPES[type];
                    const existingConfig = selected.kind === "task"
                      ? (selected.task?.config ?? meta?.defaultConfig ?? {})
                      : selected.kind === "command"
                      ? {
                          command: selected.command ?? "",
                          ...(selected.working_dir !== undefined ? { working_dir: selected.working_dir } : {}),
                          ...(selected.timeout_sec !== undefined ? { timeout_sec: selected.timeout_sec } : {}),
                        }
                      : (meta?.defaultConfig ?? {});
                    updatePhase(selected.id, {
                      kind: "task",
                      task: { type, config: existingConfig },
                      approval: undefined,
                      agent_id: undefined,
                      routes: null,
                      command: undefined,
                      working_dir: undefined,
                      timeout_sec: undefined,
                    });
                  }}
                  style={{ flex: 1 }}
                >
                  Task
                </button>
                <button
                  type="button"
                  className={selected.kind === "approval" ? "primary" : ""}
                  onClick={() => updatePhase(selected.id, {
                    kind: "approval",
                    approval: selected.approval ?? { message: "Review and approve to continue." },
                    agent_id: undefined,
                    task: undefined,
                    director: undefined,
                    routes: null,
                    command: undefined,
                    working_dir: undefined,
                    timeout_sec: undefined,
                  })}
                  style={{ flex: 1 }}
                >
                  Approval
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                {selected.kind === "approval"
                  ? "Pauses the run until you click Approve / Reject in the run view."
                  : getTaskKindForPhase(selected) !== null
                  ? "Gate — deterministic check (no AI, no tokens). Director runs it on demand; ok=true unblocks mark_done."
                  : "Skill — AI specialist Director can dispatch. Verdict drives Director's next decision."}
              </div>
            </div>
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
            {selected.kind !== "director" && (() => {
              const selectedAgent = selected.agent_id ? agentsById.get(selected.agent_id) : null;
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
              <div className="form-row">
                <label>agent</label>
                <select
                  value={selected.agent_id ?? ""}
                  onChange={(e) => updatePhase(selected.id, { agent_id: e.target.value })}
                >
                  {project.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.role})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-row">
              <label>next phase (on success)</label>
              <select
                value={selected.next ?? ""}
                onChange={(e) => updatePhase(selected.id, { next: e.target.value || null })}
              >
                <option value="">(none — workflow ends)</option>
                {wf.phases
                  .filter((p) => p.id !== selected.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} ({getTaskKindForPhase(p) ?? (p.agent_id ? agentsById.get(p.agent_id)?.role ?? "?" : "?")})
                    </option>
                  ))}
              </select>
            </div>
            {getTaskKindForPhase(selected) === null && (
              <div className="form-row">
                <label>conditional routes (verdict.route → phase)</label>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
                  If the agent's verdict has a <code>route</code> string matching one of these keys,
                  the engine jumps to the mapped phase instead of using <code>next</code>.
                </div>
                <RoutesEditor
                  phase={selected}
                  phases={wf.phases}
                  onChange={(routes) => updatePhase(selected.id, { routes })}
                />
              </div>
            )}
            <div className="form-row">
              <label>retry target (when verdict.ok=false)</label>
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
              <label>max attempts</label>
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
                <label>agent timeout (seconds, 0 = none, max 3600)</label>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  value={selected.timeout_sec ?? 0}
                  onChange={(e) => updatePhase(selected.id, { timeout_sec: Number(e.target.value) || undefined })}
                />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                  If the agent runs longer than this, it's killed and the verdict becomes ok=false (so retry kicks in).
                </div>
              </div>
            )}
            {getTaskKindForPhase(selected) === null && (
              <div className="form-row">
                <label>phase notes (appended to this phase's prompt)</label>
                <textarea
                  value={selected.notes ?? ""}
                  onChange={(e) => updatePhase(selected.id, { notes: e.target.value || null })}
                  rows={5}
                  placeholder="e.g. Focus on security review for this phase."
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
                />
              </div>
            )}
            </div>
            <div className="phase-modal-footer">
              <button onClick={() => movePhase(selected.id, -1)}>↑ Up</button>
              <button onClick={() => movePhase(selected.id, 1)}>↓ Down</button>
              <button
                onClick={() => updatePhase(selected.id, { position: null })}
                title="Forget the saved canvas position; auto-layout will re-place it."
              >
                Reset position
              </button>
              <div style={{ flex: 1 }} />
              <button className="danger" onClick={() => { deletePhase(selected.id); setSelectedPhaseId(null); }}>Delete</button>
              <button className="primary" onClick={() => setSelectedPhaseId(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

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
    </div>
  );
}

interface TemplatePickerModalProps {
  projectId: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}

function TemplatePickerModal({ projectId, onClose, onApplied }: TemplatePickerModalProps) {
  const [list, setList] = useState<WorkflowPreset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.listWorkflowPresets().then(setList).catch((e) => setErr(e.message));
  }, []);

  async function apply(key: string) {
    if (!confirm(
      "Apply this template? It will REPLACE the current playbook and add any missing agents " +
      "(existing agents with the same name are kept).",
    )) return;
    setBusy(key);
    setErr(null);
    try {
      const r = await api.applyWorkflowPreset(projectId, key);
      alert(`Applied: +${r.agents_added} agent(s), ${r.agents_existing} kept, ${r.phases} phases.`);
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
      <div className="modal" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
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
      <form className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
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
