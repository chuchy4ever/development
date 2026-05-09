/**
 * English strings. Keys are dot-paths grouped by area.
 * Keep entries SHORT — they're labels, not paragraphs.
 */
export const en: Record<string, string> = {
  // Common
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.edit": "Edit",
  "common.add": "Add",
  "common.remove": "Remove",
  "common.reset": "Reset",
  "common.apply": "Apply",
  "common.confirm": "Confirm",
  "common.loading": "Loading…",
  "common.saving": "Saving…",
  "common.saved": "Saved",
  "common.dirty": "Save changes",
  "common.optional": "optional",
  "common.idle": "idle",
  "common.export": "Export",
  "common.search": "Search",
  "common.show_all": "show all",
  "common.show_legacy_graph": "show legacy graph (advanced)",
  "common.run": "Run",
  "common.cost": "cost",
  "common.status": "status",
  "common.branch": "branch",
  "common.exit": "exit",

  // Project tabs
  "tab.board": "Board",
  "tab.playbook": "Playbook",
  "tab.memory": "Memory",
  "tab.settings": "Settings",

  // Banner
  "banner.director_orchestrates": "Director orchestrates this playbook.",
  "banner.director_explains": "You design the library of skills (AI steps) and gates (deterministic checks); Director picks which to run, in what order, based on the ticket. Solid arrows are escalation rules Director respects; dotted arrows are common follow-ups (advisory).",

  // Sections
  "section.specialists.title": "Specialists",
  "section.specialists.summary_one": "{count} agent definition (prompts, models, tools)",
  "section.specialists.summary_many": "{count} agent definitions (prompts, models, tools)",
  "section.skills.title": "Skills",
  "section.skills.summary_one": "{count} AI specialist Director can dispatch",
  "section.skills.summary_many": "{count} AI specialists Director can dispatch",
  "section.gates.title": "Gates",
  "section.gates.summary_one": "{count} deterministic check (CI, lint, deploy, approval)",
  "section.gates.summary_many": "{count} deterministic checks (CI, lint, deploy, approval)",
  "section.gates.empty": "No gates yet. Add ci_gate (composer ci), lint, deploy, or human approval.",
  "section.teams.title": "Teams",
  "section.teams.summary_one": "{count} capability group of agents (devops / dev / review / security…)",
  "section.teams.summary_many": "{count} capability groups of agents (devops / dev / review / security…)",
  "section.teams.empty": "No teams configured. Director treats agents individually. Add teams to give Director a clearer “who handles what” map.",
  "section.playbooks.title": "Named Playbooks",
  "section.playbooks.summary_one": "{count} recipe Director can pick from",
  "section.playbooks.summary_many": "{count} recipes Director can pick from",
  "section.playbooks.empty": "No named Playbooks yet. Director composes ad-hoc dispatches from the skill/gate library. Add a Playbook for a known-good recipe (e.g. \"small_change\", \"feature\", \"bug_fix\").",

  // Buttons
  "btn.add_skill": "Add skill",
  "btn.add_gate": "Add gate",
  "btn.add_team": "Add team",
  "btn.add_playbook": "Add Named Playbook",
  "btn.add_step": "step",
  "btn.add_specialist": "New specialist",
  "btn.add_from_template": "Add from template…",
  "btn.apply_template": "Apply template",
  "btn.save_as_template": "Save as template",
  "btn.reset_default": "Reset to default",
  "btn.start_run": "Start run",
  "btn.open_pr": "Open PR",
  "btn.cancel_run": "Cancel",
  "btn.approve": "Approve & continue",
  "btn.reject": "Reject",
  "btn.export_log": "Export log",

  // Run view
  "run.title": "Run {id}",
  "run.live_log": "Live log ({count})",
  "run.diff": "Diff ({count})",
  "run.flow": "FLOW:",
  "run.no_diff": "No diff yet.",
  "run.no_match": "No events match the active filters.",
  "run.failure_reason": "Failure reason:",
  "run.awaiting_approval": "Awaiting your approval",

  // Filters
  "filter.director": "Director",
  "filter.tools": "Tools",
  "filter.phases": "Phases",
  "filter.system": "System",
  "filter.errors": "Errors",
  "filter.diffs": "Diffs",

  // Team boards
  "teams_strip.members_one": "{count} member",
  "teams_strip.members_many": "{count} members",

  // Board tab
  "board.bulk_import": "Bulk import",
  "board.col.inbox": "Inbox",
  "board.col.backlog": "Backlog",
  "board.col.running": "Running",
  "board.col.review": "Review",
  "board.col.done": "Done",
  "board.col.blocked": "Blocked",

  // Settings
  "settings.project_specifics": "Project specifics for this playbook",
  "settings.project_specifics_hint": "Markdown injected into every agent's prompt during runs of this project.",

  // Lang toggle
  "lang.cs": "Čeština",
  "lang.en": "English",
};
