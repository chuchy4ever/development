# Director pattern — design notes

This branch (`director-pattern`) sketches the Claude-Code-style "top agent
orchestrates sub-agents" architecture as an alternative to the static workflow
in `main`. **This is a design + skeleton — not a working implementation.**

## TL;DR

```
Static workflow (main):                Director pattern (this branch):
                                       
  engine → tech_lead → architect       engine → director_phase
       → junior → senior →                  └→ director (Claude)
       → reviewer → ci_gate →                  uses tools:
       → tester → closer                         · dispatch_junior(notes)
                                                  · dispatch_senior(notes)
  Cesta předem daná, retry budget         · request_review()
  fixed in workflow.                          · run_ci_gate()
                                              · recommend_decompose()
  Engine = orchestrator.                      · mark_done()
                                              · give_up(reason)
                                       
                                       Director rozhoduje on-the-fly.
                                       Engine = runtime + budget guard.
```

## Why consider this

**Statický workflow (current) has fundamental limits**:
- Hard-coded retry counts (`max_attempts: 4`) — no concept of "give Junior one more shot, but with much more context" vs "escalate to architect".
- Can't pivot strategy mid-run. If `ci_gate` keeps failing for the same reason, retry loop just repeats with same prompt.
- Workflow editor is per-project; new patterns require new graphs.

**Director adapts**:
- After Senior bounces twice with same root cause, Director can decide "Junior won't fix this; let me dispatch Senior with surgical instructions" or "this is architectural, re-plan first".
- For pure-infra tickets, Director skips Architect entirely.
- For tickets with cross-cutting concerns, Director can interleave: Junior writes code → Senior reviews → Junior writes more — without the static graph forcing Reviewer in between.

**Cost trade-off** (numbers from real Agarden runs today):
- Static avg per ticket: $4-9 (simple) / $8-25 (complex with retries)
- Director estimate: $5-12 (simple — overhead) / $5-15 (complex — saved by smart routing)
- Failure rate: static ~30% → director estimated ~10-15%
- One-time engineering cost: ~4 days

**When NOT to switch**:
- Tickets are mostly simple, single-phase fixes — overhead doesn't pay off.
- You value debuggability ("why did engine choose X?") over adaptiveness.
- Rate of new project types is low — workflow editor + templates suffice.

## Design

### Phase kind = "director"

In shared types:

```ts
interface DirectorConfig {
  /** System prompt addendum specific to this project (style, conventions). */
  project_brief?: string;
  /** Maximum sub-agent dispatches in one run. Hard guard against runaway. */
  max_iterations?: number;        // default 12
  /** Hard budget cap (USD). Director gets warned at 80%, hard-stop at 100%. */
  budget_usd?: number;            // default 8
  /** Which sub-agents Director can dispatch by name (must exist as project agents). */
  available_subagents?: string[]; // default: all coder/reviewer/tester roles
}

interface WorkflowPhase {
  kind?: "agent" | "task" | "director" | ...;
  director?: DirectorConfig;
  // ...
}
```

A workflow can have ONE director phase replacing the entire downstream graph,
or directors can chain (rare). Typical setup:

```
[entry] director_main [end]
```

Director phase has no `next` (Director itself decides terminate).

### Director system prompt (sketch)

```
You are a Director — the lead orchestrator for ticket #{ticket_key}.

You CANNOT write code yourself. You operate by dispatching sub-agents:

Available sub-agents (call as JSON tool):
- dispatch_junior(notes) — Junior PHP coder. Cheap (Haiku). Bulk implementation. Use for routine work.
- dispatch_senior(notes) — Senior PHP coder. Expensive (Opus). Quality + architectural fixes. Use after Junior or for tricky problems.
- dispatch_reviewer() — Code reviewer. Reads diff, returns issue list. No code writes.
- dispatch_devops(notes) — Infrastructure / Docker / CI agent. Pure infra work.
- request_decompose(reason) — Hand ticket to CTO for splitting into subtickets. Run ends.
- run_ci_gate() — Run composer ci in Docker. Returns pass/fail + tail output.
- mark_done(summary) — All acceptance criteria met. Run ends as succeeded.
- give_up(reason) — Stuck / blocked. Run ends as failed. Use sparingly.

Each turn:
1. Reflect on what's been done (history below) and what's left (acceptance criteria).
2. Decide ONE action (call exactly one tool).
3. Wait for the result and decide next.

Rules of thumb:
- Start cheap (Junior + Reviewer cycle). Escalate to Senior only when Junior bounces twice OR review surfaces architectural issues.
- After ANY meaningful diff, call request_decompose(...) IF you realize the ticket
  is actually multiple unrelated concerns.
- Never dispatch the same sub-agent more than 4 times total in one run.
- run_ci_gate() before mark_done(); if ci_gate fails, dispatch the right sub-agent
  to fix and retry — but if you've already retried twice, call give_up.

Your replies are JSON only:
{
  "rationale": "<1-2 sentences why this action>",
  "action": "dispatch_junior" | "dispatch_senior" | ...,
  "args": { "notes": "...", "summary": "...", etc. }
}
```

### Engine integration

`apps/server/src/director.ts`:

```ts
export async function runDirectorPhase(args: {
  runId: string;
  project: ProjectWithRepos;
  ticket: Ticket;
  phase: WorkflowPhase;
  worktrees: Worktree[];
  cwd: string;
  emit: (event: string, payload: any) => void;
}): Promise<{ ok: boolean; summary: string; iterations: number }> {
  const cfg = args.phase.director ?? {};
  const maxIter = cfg.max_iterations ?? 12;
  const budgetUsd = cfg.budget_usd ?? 8;

  let iter = 0;
  let totalCost = 0;
  const history: TurnRecord[] = [];

  while (iter < maxIter && totalCost < budgetUsd) {
    iter++;
    
    // 1. Director call: "what's next?"
    const decision = await callDirector(args, history, totalCost);
    totalCost += decision.cost;

    if (decision.action === "mark_done") {
      return { ok: true, summary: decision.args.summary, iterations: iter };
    }
    if (decision.action === "give_up") {
      return { ok: false, summary: decision.args.reason, iterations: iter };
    }
    if (decision.action === "request_decompose") {
      // Trigger CTO decompose flow (existing infra)
      await decomposeTicket(...);
      return { ok: true, summary: "decomposed", iterations: iter };
    }

    // 2. Dispatch sub-agent
    const result = await dispatchSubagent(args, decision);
    totalCost += result.cost;

    history.push({ decision, result });
  }

  return { ok: false, summary: "max iterations / budget reached", iterations: iter };
}
```

`runs.ts` gets a new branch:

```ts
if (phase.kind === "director") {
  const r = await runDirectorPhase({...});
  emit phase_end with verdict { ok, summary }
  // No retry_target on director — Director handles its own retries internally
  break;  // director phase is terminal
}
```

### Sub-agent dispatch reuses existing infra

`dispatchSubagent` is essentially a wrapper around `runAgent` (existing in
`agents.ts`). It picks the right `AgentSpec` from the project's agents based on
the action name (`dispatch_junior` → "PHP Junior Coder", `dispatch_senior` →
"PHP Senior Coder", etc.).

The sub-agent gets:
- The ticket
- The Director's `notes` as `phaseNotes`
- Current diff
- Episodic memory (recent runs)
- All the same context as in static workflow

Result back to Director:
- verdict (ok / issues / summary)
- diff_summary (files changed, line counts)
- exit_code
- error if any

### Observability

Each Director iteration emits:
- `director_decision` event (rationale + action)
- `director_dispatch` event (sub-agent invoked)
- Sub-agent itself emits `phase_start` / `phase_end` like in static workflow

UI in `RunView` shows a chronological timeline:
```
[Director] reflecting…
  → dispatch_junior(notes: "add /version endpoint")
[Junior] running…
  ← ok=null, 1 commit
[Director] thinking…
  → request_review()
[Reviewer] running…
  ← ok=true
[Director] reflecting…
  → run_ci_gate()
[ci_gate] running…
  ← ok=true
[Director] mark_done("acceptance met, all green")
✅ DONE
```

### Hybrid: best of both

The cleanest design: **director phase replaces the middle of the workflow,
not the entire thing**. So:

```
tech_lead → director_main → closer
```

Tech Lead still does initial classification (cheap, Sonnet, $0.20). If
Tech Lead says "decompose", existing flow runs. If Tech Lead says "do it",
hand to Director. Closer at end is symbolic handover.

This bounds Director's role to actual work-getting-done, with cheap
gates around it.

## What's in this branch

- `DIRECTOR-PATTERN.md` (this file)
- `apps/server/src/director.ts` — skeleton (not working — has TODOs)
- shared types: extension for `kind: "director"` + `DirectorConfig`

## What's NOT in this branch

- Engine integration (runs.ts branch)
- UI changes (RunView timeline)
- Validation (PUT /workflow accepting director phases)
- Tests
- Migration guide for existing workflows

## Next steps to make it real

1. Wire `runDirectorPhase` into `runs.ts` engine loop (replace existing phase branches when kind="director").
2. Implement `dispatchSubagent` reusing `runAgent` from agents.ts.
3. Implement `callDirector` — single Claude call with structured JSON output schema. Prompt-engineer the system prompt iteratively against real tickets.
4. UI: Director timeline component in RunView.
5. Migrate one project to director mode side-by-side with static workflow on another. A/B test on identical tickets to validate cost/quality claims.
6. Once stable, deprecate static workflow OR keep as opt-in (fast path for trivial tickets).

## Honest assessment

This pattern **is real engineering work**. The skeleton in this branch is
maybe 10% of the total. Don't merge to main until you've:
- Run 10+ real tickets through Director
- Compared cost/success vs. static workflow on the same tickets
- Built the UI timeline (without it Director runs are opaque)

If after 4-5 days you're not seeing clear wins, **kill the branch** and stay
with the static workflow. It's simpler, cheaper, and battle-tested.
