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

  // Skill / phase modal
  "skill.modal.id": "id",
  "skill.modal.kind": "typ",
  "skill.modal.kind.agent": "Agent (AI)",
  "skill.modal.kind.task": "Gate",
  "skill.modal.kind.approval": "Schválení",
  "skill.modal.agent": "Agent",
  "skill.modal.notes": "Poznámky (přidávají se k promptu skillu při každém spuštění)",
  "skill.modal.notes_placeholder": "např. Pro tuhle fázi se zaměř na bezpečnostní review.",
  "skill.modal.timeout": "Agent timeout (sekundy, 0 = žádný, max 3600)",
  "skill.modal.timeout_hint": "Tvrdý strop na jeden dispatch. Když se překročí, sub-agent se zabije a Director vidí ok=false.",
  "skill.modal.advanced": "Hint pro graf (volitelné — Director je čte jen při plánování)",
  "skill.modal.advanced_hint": "Director je čte jako doporučenou návaznost, eskalaci při selhání nebo podmíněné routy. Může je všechny ignorovat. Většinou stačí nechat prázdné.",
  "skill.modal.next": "obvyklá návaznost",
  "skill.modal.retry": "při selhání eskaluj na",
  "skill.modal.max_attempts": "max pokusů (legacy retry budget; Director ignoruje)",
  "skill.modal.routes": "podmíněné routy (verdict.route → fáze) — legacy",
  "skill.modal.up": "↑ Nahoru",
  "skill.modal.down": "↓ Dolů",
  "skill.modal.reset_pos": "Reset pozice v grafu",
  "skill.modal.kind_hint.agent": "Skill — AI specialista, kterého může Director volat. Verdikt řídí jeho další rozhodnutí.",
  "skill.modal.kind_hint.task": "Gate — deterministická kontrola (žádný AI, žádné tokeny). Director ji volá na požádání; ok=true odemkne mark_done.",
  "skill.modal.kind_hint.approval": "Pozastaví běh, dokud nestiskneš Schválit / Odmítnout v run view.",
  "skill.modal.approval_message": "Zpráva pro schvalovatele (markdown)",
  "skill.modal.approval_message_placeholder": "např. Zkontroluj diffy výše. Schválit otevře PR; odmítnout pošle zpět na Seniora.",

  // Team modal
  "team.modal.new": "Nový tým",
  "team.modal.edit": "Upravit tým: {name}",
  "team.modal.name": "Název",
  "team.modal.name_placeholder": "Dev Team",
  "team.modal.category": "Kategorie",
  "team.modal.no_category": "bez kategorie",
  "team.modal.description": "Popis",
  "team.modal.description_placeholder": "kdy si tenhle tým vzít",
  "team.modal.members": "Členové ({count})",
  "team.modal.delete": "Smazat tým",
  "team.modal.create": "Vytvořit tým",
  "team.modal.confirm_delete": "Smazat tým „{name}\"?",
  "team.flow.title": "TOK TÝMŮ",
  "team.flow.recipes": "📖 Recepty, které tyto týmy procházejí:",
  "team.flow.steps": "{count} kroků",
  "team.flow.add": "přidat tým",

  // Playbook modal / panel
  "playbook.name_placeholder": "název receptu (např. small_change)",
  "playbook.description_placeholder": "kdy použít (např. triviální endpoint, malý bugfix)",
  "playbook.steps_label": "Kroky (Director je projde v pořadí):",
  "playbook.add_step": "krok",

  // Toolbar
  "toolbar.add": "+ Přidat",
  "toolbar.add_agent": "Agent (AI)",
  "toolbar.add_approval": "Schvalovací gate",
  "toolbar.layout": "Rozložení",
  "toolbar.auto_arrange": "Auto-uspořádat",
  "toolbar.align": "Zarovnat řádky",
  "toolbar.distribute": "Rozprostřít",
  "toolbar.unsaved": "Neuloženo",

  // ProjectStats
  "stats.total_spent": "Celkem utraceno",
  "stats.today": "dnes",
  "stats.cap": "limit",
  "stats.avg_per_run": "Průměr na běh",
  "stats.runs": "{count} běhů",
  "stats.last_7d": "posledních 7 dní",
  "stats.tickets": "Tikety",
  "stats.success_rate": "Úspěšnost",
  "stats.runtime": "Celkový čas běhu",
  "stats.runtime_sub": "za {count} běh",
  "stats.runtime_sub_plural": "za {count} běhů",
  "stats.saved": "Odhad ušetřeného času",
  "stats.saved_sub": "1.5h × úspěšné běhy (hrubý odhad)",
  "stats.running": "{count} běží",

  // RunView
  "run.flow.dispatching": "spouští",
  "run.flow.subagent_done": "hotovo",
  "run.flow.director_start": "Director start",
  "run.flow.director_end": "Director konec",
  "run.confirm_cancel": "Zrušit tento běh? Coder proces bude ukončen.",
  "run.confirm_reject": "Odmítnout schválení? Běh se vrátí na předchozí fázi (pokud má retry target), jinak skončí jako failed.",
  "run.cancel_failed": "Zrušení selhalo",
  "run.openpr_failed": "Otevření PR selhalo",
  "run.approve_failed": "Schválení selhalo",
  "run.reject_failed": "Odmítnutí selhalo",
  "run.approval_note_placeholder": "volitelná poznámka (audit trail)",
  "run.export_log_title": "Stáhnout všechny eventy jako JSON pro debug",
  "run.agent_breakdown": "ROZPAD AGENTŮ · {count} agentů · ${total} celkem",

  // Banner
  "banner.dismiss": "rozumím, skrýt",

  // Confirm dialogs
  "confirm.reset_playbook": "Resetovat playbook na výchozí (jeden skill na roli)?",
  "confirm.apply_template": "Použít tuto šablonu? PŘEPÍŠE aktuální playbook a přidá chybějící agenty (existující zůstanou).",
  "confirm.delete_team": "Smazat tým „{name}\"?",

  // Run view tabs
  "run.tab.overview": "📊 Přehled",
  "run.tab.overview_empty": "Žádné eventy zatím. Až Director začne, uvidíš tady průběh + rozpad agentů.",
  "run.tab.director": "🎬 Director ({count})",
  "run.tab.log": "📜 Log ({count})",

  // Bulk import
  "bulk.spec_intro": "Máš volný spec (zadani.md, brain dump…)? Klikni a CTO ti ho rozdělí na tickety v správném formátu — pak si je nahoře zreviewuješ a importneš.",
  "bulk.spec_btn": "↻ Rozložit spec na tickety",
  "bulk.spec_busy": "Rozkládám…",

  // Connector health / age
  "age.just_now": "právě teď",
  "age.minutes": "před {n} min",
  "age.hours": "před {n} h",
  "age.days": "před {n} d",

  // Workflow editor — preset picker + panels + shell wizard
  "wf.preset.btn": "📦 Použít preset",
  "wf.preset.btn_title_gate": "Vyber z hotové sady CI / lint / approval / git_push presetů",
  "wf.preset.btn_title_connector": "Vyber z hotové sady connectorů",
  "wf.preset.modal_title": "📦 Vyber preset",
  "wf.preset.modal_hint": "Hotové konfigurace pro běžné případy. Po importu si je můžeš upravit per-projekt — žádné live napojení na knihovnu, žádná synchronizace zpět.",
  "wf.preset.empty": "(žádné presety pro tuhle sekci)",
  "wf.preset.close": "Zavřít",
  "wf.preset.cat.ci": "CI & lint gates",
  "wf.preset.cat.git": "Git push",
  "wf.preset.cat.approval": "Human approval",
  "wf.preset.cat.deploy": "Deploy & ops",
  "wf.connectors.add": "+ Přidat konektor",
  "wf.connectors.empty": "Žádný konektor. Použij preset, nebo přidej Jira / GitHub / SSH abys reportoval výsledek runu navenek.",
  "wf.shell.wizard_close": "✕ Zrušit wizard, napsat příkaz ručně",
  "wf.shell.wizard_open": "📋 Použít wizard pro Make / npm / Docker / Composer",
  "wf.git_push.intro": "Po dokončení runu pushne base branch každého repa projektu na zadaný remote. Pracuje pro GitLab i GitHub — používá git CLI nad existující remote konfigurací, žádné platform-specific API. Engine se postará o lokální merge worktree → base; tato akce jen pushne ven (případně přepíše merge na jeden squash commit).",
  "wf.git_push.remote": "remote",
  "wf.git_push.when": "push when",
  "wf.git_push.when.success": "only on success (recommended)",
  "wf.git_push.when.always": "always (even on failure — push partial work)",
  "wf.git_push.when.failure": "only on failure (rare)",
  "wf.git_push.strategy": "strategy",
  "wf.git_push.strategy.ff": "ff-only (zachová všechny sub-agent commits)",
  "wf.git_push.strategy.squash": "squash (jeden commit s vlastní message)",
  "wf.git_push.strategy_hint": "ff-only: ponechá 10+ drobných commitů od Junior/Senior. squash: všechno do jednoho commitu se zprávou níže — čistší git log.",
  "wf.git_push.template": "commit message template",
  "wf.git_push.template_placeholder": "implement {ticket_title}",
  "wf.git_push.template_hint": "Placeholders: {placeholders}",

  // Run verdict
  "verdict.title": "Tvůj verdikt:",
  "verdict.good": "✓ Funguje",
  "verdict.bad": "✗ Špatně",
  "verdict.broken_in_prod": "⚠ Rozbilo se v produkci",
  "verdict.prompt_bad": "Co bylo špatně? (zobrazí se v episodic memory)",
  "verdict.prompt_broken": "Co se rozbilo v produkci? (zobrazí se v episodic memory pro budoucí runy)",
  "verdict.failed": "Verdikt selhal",

  // Admin metrics
  "metrics.verdicts.title": "Verdikty od uživatele",
  "metrics.verdicts.unrated": "Bez verdiktu",
  "metrics.verdicts.empty": "Žádné dokončené runy zatím.",
};
