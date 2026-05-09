import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import type {
  AgentBundleEntry,
  ApplyTemplateResult,
  ProjectWithRepos,
  TemplatePhase,
  WorkflowDefinition,
  WorkflowPreset,
} from "@ceo/shared";
import { normalizePhase } from "@ceo/shared";
import { DATA_DIR } from "./config.js";
import { db, nowIso } from "./db.js";
import { loadProjectWithRepos } from "./store.js";
import { AGENT_TEMPLATES } from "./defaultAgents.js";

/** Replace task-specific secrets (Telegram tokens, future API keys) with a
 *  placeholder before exporting a workflow as a shareable template. */
function redactTaskSecrets(type: string, config: Record<string, unknown>): Record<string, unknown> {
  if (type === "telegram") {
    return { ...config, bot_token: "<REDACTED — fill in after applying>" };
  }
  return config;
}

function promptByKey(key: string): string {
  const t = AGENT_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`builtin prompt for "${key}" not found`);
  return t.system_prompt;
}

const TEMPLATES_DIR = path.join(DATA_DIR, "templates");

function ensureTemplatesDir() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

function templatePath(key: string): string {
  return path.join(TEMPLATES_DIR, `${key}.json`);
}

// --- Built-in templates ----------------------------------------------------

function phpTeamTemplate(): WorkflowPreset {
  // Mirrors what scripts/setup-php-workflow.mjs writes — bundled so users can
  // clone it into a fresh project without running CLI.
  return {
    key: "php-team",
    name: "PHP team",
    description:
      "Tech Lead routes to Architect or Junior. Junior writes the bulk; Senior is the finisher (no bouncing). Reviewer/Closer retry to Senior on issues.",
    source: "builtin",
    agents: [
      {
        name: "Tech Lead",
        role: "coder",
        category: "Strategy",
        system_prompt: promptByKey("tech_lead"),
        model: "claude-sonnet-4-6",
        allowed_tools: ["Read", "Grep", "Glob"],
      },
      {
        name: "Architect",
        role: "coder",
        category: "Architecture",
        system_prompt: promptByKey("architect"),
        model: "claude-opus-4-7",
        allowed_tools: null,
      },
      {
        name: "PHP Junior Coder",
        role: "coder",
        category: "Development",
        system_prompt: promptByKey("php_junior"),
        model: "claude-haiku-4-5-20251001",
        allowed_tools: null,
      },
      {
        name: "PHP Senior Coder",
        role: "coder",
        category: "Development",
        system_prompt: promptByKey("php_senior"),
        model: "claude-opus-4-7",
        allowed_tools: null,
      },
      {
        name: "Reviewer",
        role: "reviewer",
        category: "Code Review",
        system_prompt: promptByKey("reviewer"),
        model: "claude-sonnet-4-6",
        allowed_tools: null,
      },
      {
        name: "Tester",
        role: "tester",
        category: "QA",
        system_prompt: promptByKey("tester"),
        model: null,
        allowed_tools: null,
      },
      {
        name: "Closer",
        role: "reviewer",
        category: "Strategy",
        system_prompt: promptByKey("closer"),
        model: "claude-sonnet-4-6",
        allowed_tools: ["Read", "Grep", "Glob", "Bash"],
      },
    ],
    phases: [
      {
        id: "tech_lead",
        agent_name: "Tech Lead",
        next: "php_junior",
        routes: { architect: "architect", dev: "php_junior" },
        position: { x: 60, y: 240 },
      },
      { id: "architect", agent_name: "Architect", next: "php_junior", position: { x: 240, y: 80 } },
      { id: "php_junior", agent_name: "PHP Junior Coder", next: "php_senior", position: { x: 420, y: 240 } },
      { id: "php_senior", agent_name: "PHP Senior Coder", next: "reviewer", position: { x: 600, y: 240 } },
      { id: "reviewer", agent_name: "Reviewer", next: "ci_gate", retry_target: "php_senior", max_attempts: 2, position: { x: 780, y: 240 } },
      // CI gate runs BEFORE the tester: if automated tests/lint fail, no point
      // spinning up the app for black-box exploration — bounce to Senior first.
      {
        id: "ci_gate",
        kind: "task",
        task: {
          type: "shell",
          config: {
            command: "if [ -f Makefile ] && grep -qE '^ci:' Makefile; then make ci; elif [ -f composer.json ]; then composer install --no-interaction --prefer-dist && (composer test || vendor/bin/phpunit) && (composer lint || vendor/bin/phpstan analyse --no-progress); else echo 'no CI configured'; fi",
            timeout_sec: 900,
          },
        },
        next: "tester",
        retry_target: "php_senior",
        max_attempts: 2,
        position: { x: 960, y: 240 },
      },
      { id: "tester", agent_name: "Tester", next: "closer", retry_target: "php_senior", max_attempts: 2, position: { x: 1140, y: 240 } },
      { id: "closer", agent_name: "Closer", next: null, retry_target: "php_senior", max_attempts: 2, position: { x: 1320, y: 240 } },
    ],
    project_specifics:
      "PHP project. Follow PSR-12, declare(strict_types=1) at the top of every PHP file, type-hint all parameters and returns. Use the project's framework conventions (composer.json reveals which one). Tests live next to the code under test (PHPUnit or Pest).",
  };
}

function genericTeamTemplate(): WorkflowPreset {
  return {
    key: "generic-team",
    name: "Generic team (any language)",
    description:
      "Same shape as PHP team but with language-agnostic Junior/Senior. Use for non-PHP projects.",
    source: "builtin",
    agents: [
      {
        name: "Tech Lead",
        role: "coder",
        category: "Strategy",
        system_prompt: promptByKey("tech_lead"),
        model: "claude-sonnet-4-6",
        allowed_tools: ["Read", "Grep", "Glob"],
      },
      {
        name: "Junior Coder",
        role: "coder",
        category: "Development",
        system_prompt: promptByKey("junior_coder"),
        model: "claude-haiku-4-5-20251001",
        allowed_tools: null,
      },
      {
        name: "Senior Coder",
        role: "coder",
        category: "Development",
        system_prompt: promptByKey("senior_coder"),
        model: "claude-opus-4-7",
        allowed_tools: null,
      },
      {
        name: "Reviewer",
        role: "reviewer",
        category: "Code Review",
        system_prompt: promptByKey("reviewer"),
        model: "claude-sonnet-4-6",
        allowed_tools: null,
      },
      {
        name: "Tester",
        role: "tester",
        category: "QA",
        system_prompt: promptByKey("tester"),
        model: null,
        allowed_tools: null,
      },
      {
        name: "Closer",
        role: "reviewer",
        category: "Strategy",
        system_prompt: promptByKey("closer"),
        model: "claude-sonnet-4-6",
        allowed_tools: ["Read", "Grep", "Glob", "Bash"],
      },
    ],
    phases: [
      { id: "tech_lead", agent_name: "Tech Lead", next: "junior", position: { x: 60, y: 240 } },
      { id: "junior", agent_name: "Junior Coder", next: "senior", position: { x: 240, y: 240 } },
      { id: "senior", agent_name: "Senior Coder", next: "reviewer", position: { x: 420, y: 240 } },
      { id: "reviewer", agent_name: "Reviewer", next: "tester", retry_target: "senior", max_attempts: 2, position: { x: 600, y: 240 } },
      { id: "tester", agent_name: "Tester", next: "closer", retry_target: "senior", max_attempts: 2, position: { x: 780, y: 240 } },
      { id: "closer", agent_name: "Closer", next: null, retry_target: "senior", max_attempts: 2, position: { x: 960, y: 240 } },
    ],
  };
}

function soloDevTemplate(): WorkflowPreset {
  return {
    key: "solo-dev",
    name: "Solo dev (minimal)",
    description: "Single Coder + Tester. For small tickets where retry/review overhead doesn't pay off.",
    source: "builtin",
    agents: [
      {
        name: "Coder",
        role: "coder",
        category: "Development",
        system_prompt: promptByKey("junior_coder"),
        model: "claude-sonnet-4-6",
        allowed_tools: null,
      },
      {
        name: "Tester",
        role: "tester",
        category: "QA",
        system_prompt: promptByKey("tester"),
        model: null,
        allowed_tools: null,
      },
    ],
    phases: [
      { id: "coder", agent_name: "Coder", next: "tester", position: { x: 60, y: 240 } },
      { id: "tester", agent_name: "Tester", next: null, position: { x: 240, y: 240 } },
    ],
  };
}

const BUILTIN: () => WorkflowPreset[] = () => [
  phpTeamTemplate(),
  genericTeamTemplate(),
  soloDevTemplate(),
];

// --- File-backed user templates -------------------------------------------

export function listTemplates(): WorkflowPreset[] {
  ensureTemplatesDir();
  const builtin = BUILTIN();
  const userKeys = new Set(builtin.map((t) => t.key));
  const userTemplates: WorkflowPreset[] = [];
  for (const file of fs.readdirSync(TEMPLATES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8");
      const t = JSON.parse(content) as WorkflowPreset;
      // User templates always reported as source="user" regardless of file content.
      t.source = "user";
      if (!userKeys.has(t.key)) userTemplates.push(t);
    } catch {
      // Ignore corrupt files.
    }
  }
  return [...builtin, ...userTemplates];
}

export function getTemplate(key: string): WorkflowPreset | null {
  return listTemplates().find((t) => t.key === key) ?? null;
}

export function deleteUserTemplate(key: string): boolean {
  const builtin = BUILTIN();
  if (builtin.some((t) => t.key === key)) return false;
  const p = templatePath(key);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/**
 * Capture the project's current agents + workflow into a saved template.
 * Overwrites if a template with this key already exists (and is not built-in).
 */
export function saveProjectAsTemplate(args: {
  projectId: string;
  key: string;
  name: string;
  description?: string;
}): WorkflowPreset {
  const { projectId, key, name, description } = args;
  if (BUILTIN().some((t) => t.key === key)) {
    throw new Error(`"${key}" is a built-in template key — choose a different name`);
  }
  if (!key.match(/^[a-z0-9_-]+$/i)) {
    throw new Error("template key must be alphanumeric (with - or _)");
  }
  const project = loadProjectWithRepos(projectId);
  if (!project) throw new Error("project not found");

  // Only include agents referenced by the workflow (so user can keep extras
  // private without bloating their template).
  const referencedIds = new Set(project.workflow.phases.map((p) => p.agent_id));
  const agents: AgentBundleEntry[] = project.agents
    .filter((a) => referencedIds.has(a.id))
    .map((a) => ({
      name: a.name,
      role: a.role,
      category: a.category,
      system_prompt: a.system_prompt,
      model: a.model,
      allowed_tools: a.allowed_tools,
    }));

  const agentNameById = new Map(project.agents.map((a) => [a.id, a.name]));
  const phases: TemplatePhase[] = project.workflow.phases.map(normalizePhase).map((p) => {
    if (p.kind === "task" && p.task) {
      // Redact secrets so templates can be safely shared. The user re-fills
      // them when applying the template to a fresh project.
      const config = redactTaskSecrets(p.task.type, p.task.config);
      return {
        id: p.id,
        kind: "task",
        task: { type: p.task.type, config },
        next: p.next ?? null,
        retry_target: p.retry_target ?? null,
        max_attempts: p.max_attempts,
        notes: p.notes ?? null,
        position: p.position ?? null,
      };
    }
    return {
      id: p.id,
      agent_name: p.agent_id ? (agentNameById.get(p.agent_id) ?? "") : "",
      next: p.next ?? null,
      routes: p.routes ?? null,
      retry_target: p.retry_target ?? null,
      max_attempts: p.max_attempts,
      notes: p.notes ?? null,
      position: p.position ?? null,
    };
  });

  // Bundle teams that reference at least one of the included agents. Teams
  // referencing agents NOT in this template's agents[] are kept — those
  // members will simply be dropped on apply if the destination project
  // doesn't have them.
  const teams = (project.workflow.teams ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    agent_names: [...t.agent_names],
  }));

  // Bundle named Playbooks. Their step phase_ids are stable across save/apply
  // because the template carries the exact phase IDs.
  const playbooks = (project.workflow.playbooks ?? []).map((pb) => ({
    name: pb.name,
    description: pb.description,
    steps: pb.steps.map((s) => ({ ...s })),
  }));

  const tpl: WorkflowPreset = {
    key,
    name,
    description: description ?? "",
    source: "user",
    agents,
    phases,
    teams: teams.length > 0 ? teams : undefined,
    playbooks: playbooks.length > 0 ? playbooks : undefined,
    director_config: project.workflow.director_config ?? null,
    project_specifics: project.workflow.project_specifics ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  ensureTemplatesDir();
  fs.writeFileSync(templatePath(key), JSON.stringify(tpl, null, 2), "utf8");
  return tpl;
}

/**
 * Apply a template to a project: insert any missing agents (matched by name)
 * and write the workflow with resolved agent IDs.
 */
export function applyTemplate(projectId: string, key: string): ApplyTemplateResult {
  const tpl = getTemplate(key);
  if (!tpl) throw new Error(`unknown template "${key}"`);
  const project = loadProjectWithRepos(projectId);
  if (!project) throw new Error("project not found");

  const existingByName = new Map(project.agents.map((a) => [a.name, a]));
  let added = 0;
  let existing = 0;
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, project_id, name, role, category, system_prompt, model, allowed_tools_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  for (const a of tpl.agents) {
    if (existingByName.has(a.name)) {
      existing++;
      continue;
    }
    const id = nanoid(10);
    insertAgent.run(
      id,
      projectId,
      a.name,
      a.role,
      a.category,
      a.system_prompt,
      a.model,
      a.allowed_tools ? JSON.stringify(a.allowed_tools) : null,
      now,
      now,
    );
    added++;
  }

  // Re-fetch agents after inserts.
  const updatedProject = loadProjectWithRepos(projectId)!;
  const idByName = new Map(updatedProject.agents.map((a) => [a.name, a.id]));

  // Merge teams: keep existing project teams, add any from template that don't
  // already exist (matched by id). Drop agent_names that don't resolve in the
  // destination project so the workflow validator doesn't reject the apply.
  const projectAgentNames = new Set(updatedProject.agents.map((a) => a.name));
  const existingTeamIds = new Set((updatedProject.workflow.teams ?? []).map((t) => t.id));
  let teamsAdded = 0;
  const teamsForWf = [
    ...(updatedProject.workflow.teams ?? []),
    ...((tpl.teams ?? []).filter((t) => !existingTeamIds.has(t.id))).map((t) => {
      teamsAdded++;
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        agent_names: t.agent_names.filter((n) => projectAgentNames.has(n)),
      };
    }),
  ];

  // Merge playbooks: keep existing, add any from template not already present
  // (by name). Drop steps whose phase_id won't resolve to a phase in the
  // resulting workflow (we'll recompute phase IDs below — playbooks reference
  // template phase IDs which become workflow phase IDs verbatim).
  const templatePhaseIds = new Set(tpl.phases.map((p) => p.id));
  const existingPlaybookNames = new Set((updatedProject.workflow.playbooks ?? []).map((p) => p.name));
  let playbooksAdded = 0;
  const playbooksForWf = [
    ...(updatedProject.workflow.playbooks ?? []),
    ...((tpl.playbooks ?? []).filter((pb) => !existingPlaybookNames.has(pb.name))).map((pb) => {
      playbooksAdded++;
      return {
        name: pb.name,
        description: pb.description,
        steps: pb.steps.filter((s) => templatePhaseIds.has(s.phase_id)),
      };
    }),
  ];

  const wf: WorkflowDefinition = {
    project_specifics: tpl.project_specifics ?? null,
    director_config: tpl.director_config ?? updatedProject.workflow.director_config ?? null,
    teams: teamsForWf.length > 0 ? teamsForWf : undefined,
    playbooks: playbooksForWf.length > 0 ? playbooksForWf : undefined,
    phases: tpl.phases.map((p) => {
      // Normalize legacy command-kind template entries to task shape.
      const np = normalizePhase(p as any);
      if (np.kind === "task" && np.task) {
        return {
          id: np.id,
          kind: "task" as const,
          task: { type: np.task.type, config: np.task.config },
          next: np.next ?? null,
          retry_target: np.retry_target ?? null,
          max_attempts: np.max_attempts,
          notes: np.notes ?? null,
          position: np.position ?? null,
        };
      }
      const agentName = p.agent_name ?? "";
      const agentId = idByName.get(agentName);
      if (!agentId) {
        throw new Error(`template references unknown agent "${agentName}"`);
      }
      return {
        id: p.id,
        agent_id: agentId,
        next: p.next ?? null,
        routes: p.routes ?? null,
        retry_target: p.retry_target ?? null,
        max_attempts: p.max_attempts,
        notes: p.notes ?? null,
        position: p.position ?? null,
      };
    }),
  };

  db.prepare(`UPDATE projects SET workflow_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(wf), nowIso(), projectId);

  return {
    agents_added: added,
    agents_existing: existing,
    phases: wf.phases.length,
    teams_added: teamsAdded,
    playbooks_added: playbooksAdded,
  };
}
