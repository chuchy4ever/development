/**
 * České překlady. Klíče musí být shodné s en.ts.
 * Krátké, výstižné — labely, ne věty.
 */
export const cs: Record<string, string> = {
  // Common
  "common.save": "Uložit",
  "common.cancel": "Zrušit",
  "common.delete": "Smazat",
  "common.close": "Zavřít",
  "common.edit": "Upravit",
  "common.add": "Přidat",
  "common.remove": "Odstranit",
  "common.reset": "Reset",
  "common.apply": "Použít",
  "common.confirm": "Potvrdit",
  "common.loading": "Načítám…",
  "common.saving": "Ukládám…",
  "common.saved": "Uloženo",
  "common.dirty": "Uložit změny",
  "common.optional": "volitelné",
  "common.idle": "neaktivní",
  "common.export": "Export",
  "common.search": "Hledat",
  "common.show_all": "zobrazit vše",
  "common.show_legacy_graph": "zobrazit původní graf (pokročilé)",
  "common.run": "Spustit",
  "common.cost": "cena",
  "common.status": "stav",
  "common.branch": "větev",
  "common.exit": "exit",

  // Project tabs
  "tab.board": "Board",
  "tab.playbook": "Playbook",
  "tab.memory": "Paměť",
  "tab.settings": "Nastavení",

  // Banner
  "banner.director_orchestrates": "Director řídí tento playbook.",
  "banner.director_explains": "Definuješ knihovnu skills (AI kroky) a gates (deterministické kontroly); Director vybírá, co spustit a v jakém pořadí, podle ticketu. Plné šipky jsou eskalační pravidla, která Director respektuje; tečkované jsou doporučené návaznosti (rada).",

  // Sections
  "section.specialists.title": "Specialisté",
  "section.specialists.summary_one": "{count} definice agenta (prompt, model, tools)",
  "section.specialists.summary_many": "{count} definic agentů (prompty, modely, tools)",
  "section.skills.title": "Skills",
  "section.skills.summary_one": "{count} AI specialista k dispozici Directorovi",
  "section.skills.summary_many": "{count} AI specialistů k dispozici Directorovi",
  "section.gates.title": "Gates",
  "section.gates.summary_one": "{count} deterministická kontrola (CI, lint, deploy, schválení)",
  "section.gates.summary_many": "{count} deterministických kontrol (CI, lint, deploy, schválení)",
  "section.gates.empty": "Žádné gates. Přidej ci_gate (composer ci), lint, deploy nebo lidské schválení.",
  "section.teams.title": "Týmy",
  "section.teams.summary_one": "{count} skupina agentů podle schopnosti (devops / dev / review / security…)",
  "section.teams.summary_many": "{count} skupin agentů podle schopnosti (devops / dev / review / security…)",
  "section.teams.empty": "Žádné týmy. Director jede individuálně. Přidej týmy a Director bude mít jasnější mapu „kdo co dělá“.",
  "section.playbooks.title": "Playbooky",
  "section.playbooks.summary_one": "{count} recept, který může Director použít",
  "section.playbooks.summary_many": "{count} receptů, které může Director použít",
  "section.playbooks.empty": "Žádné Playbooky. Director skládá dispatche ad-hoc z knihovny skills/gates. Přidej Playbook pro známý vzor (např. „small_change“, „feature“, „bug_fix“).",

  // Buttons
  "btn.add_skill": "Přidat skill",
  "btn.add_gate": "Přidat gate",
  "btn.add_team": "Přidat tým",
  "btn.add_playbook": "Přidat Playbook",
  "btn.add_step": "krok",
  "btn.add_specialist": "Nový specialista",
  "btn.add_from_template": "Z šablony…",
  "btn.apply_template": "Použít šablonu",
  "btn.save_as_template": "Uložit jako šablonu",
  "btn.reset_default": "Reset",
  "btn.start_run": "Spustit",
  "btn.open_pr": "Otevřít PR",
  "btn.cancel_run": "Zrušit",
  "btn.approve": "Schválit a pokračovat",
  "btn.reject": "Odmítnout",
  "btn.export_log": "Stáhnout log",

  // Run view
  "run.title": "Běh {id}",
  "run.live_log": "Live log ({count})",
  "run.diff": "Diff ({count})",
  "run.flow": "PRŮBĚH:",
  "run.no_diff": "Zatím žádný diff.",
  "run.no_match": "Žádné události neodpovídají filtru.",
  "run.failure_reason": "Důvod selhání:",
  "run.awaiting_approval": "Čeká na tvé schválení",

  // Filters
  "filter.director": "Director",
  "filter.tools": "Nástroje",
  "filter.phases": "Fáze",
  "filter.system": "Systém",
  "filter.errors": "Chyby",
  "filter.diffs": "Diffy",

  // Team boards
  "teams_strip.members_one": "{count} člen",
  "teams_strip.members_many": "{count} členů",

  // Board tab
  "board.bulk_import": "Hromadný import",
  "board.col.inbox": "Inbox",
  "board.col.backlog": "Backlog",
  "board.col.running": "Běží",
  "board.col.review": "Review",
  "board.col.done": "Hotovo",
  "board.col.blocked": "Zablokováno",

  // Settings
  "settings.project_specifics": "Specifika projektu pro tento playbook",
  "settings.project_specifics_hint": "Markdown vkládaný do promptu každého agenta při bězích tohoto projektu.",

  // Lang toggle
  "lang.cs": "Čeština",
  "lang.en": "English",
};
