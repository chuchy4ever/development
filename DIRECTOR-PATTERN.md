# Director pattern — implementation

This branch (`director-pattern`) implements Claude-Code-style "top agent
orchestrates sub-agents" architecture as an alternative to the static workflow.

**Status: working implementation, but not yet A/B tested vs static workflow.**
Use it on a project, compare cost / success rate, decide whether to merge.

## What got built

| Layer | File | Status |
|---|---|---|
| Phase kind union | `packages/shared/src/index.ts` | ✅ `kind: "director"` + `DirectorConfig` |
| Engine integration | `apps/server/src/runs.ts` | ✅ branches on `kind === "director"`, treats as terminal |
| Director core | `apps/server/src/director.ts` | ✅ `runDirectorPhase`, `callDirector`, `dispatchSubagent`, `runCiGate` |
| Validator | `apps/server/src/routes/projects.ts` | ✅ accepts director config in PUT /workflow |
| RunView timeline | `apps/web/src/components/RunView.tsx` | ✅ `director_*` events render with rationale, dispatch chain, cost per turn |
| Workflow editor | `apps/web/src/components/WorkflowEditor.tsx` | ✅ `+ Add director` palette, side-panel form (budget, iterations, project brief, sub-agent allowlist) |

Everything compiles. Server typecheck and web typecheck both clean on this branch.

## How it works

1. Workflow editor: add a Director phase. It's terminal — no `next`, no
   `retry_target`. The whole graph collapses into one phase.
2. Run starts, engine sees `kind === "director"`, calls `runDirectorPhase`.
3. Director (Claude Sonnet) gets ticket + budget + sub-agent allowlist. Each
   turn it emits a JSON decision:
   ```
   {
     "rationale": "...",
     "action": { "action": "dispatch", "subagent": "PHP Junior Coder", "notes": "..." }
   }
   ```
   or `run_ci_gate`, `request_decompose`, `mark_done`, `give_up`.
4. Engine executes the action (dispatching real sub-agents using existing
   `runAgent` machinery, or running ci_gate via the existing `runTask` shell
   infra), captures cost + diff stats, and feeds the result back to Director.
5. Director decides next turn. Loop until terminal action or budget/iterations.

## Cost capture

Director and each sub-agent return `total_cost_usd` from their stream-json
result event. Engine accumulates and emits `director_decision` /
`director_subagent_done` events with cost. Hard cap at `budget_usd`.

## Compared to the original skeleton (in the previous commit on this branch)

The skeleton had stubs for cost, diffs, and ci_gate. This commit fills them
in:
- Real Claude CLI calls via `streamClaude` with stream-json parsing for cost.
- Real sub-agent dispatch via `runAgent` + `specFromAgent` (same machinery
  as the static workflow uses for Junior/Senior/Reviewer/etc).
- Real ci_gate via `runTask("shell", …)` reusing the existing task registry.
- Real decompose via `decomposeTicket(...)` reusing the CTO infrastructure.
- Commit-counting between dispatches (so Director knows "Junior added 2
  commits last turn").

## What's NOT done

- A/B benchmark vs static workflow on identical tickets (key validation step
  before deciding to merge).
- Project brief is in the side panel but probably needs project-level
  fallback (DirectorConfig project_brief vs project.spec_md).
- Sub-agent dispatch doesn't yet stream tokens to RunView in real time —
  only the verdict at the end shows up. Could be improved with onLine
  forwarding to a per-subagent SSE channel.
- Director doesn't have a "ask user" tool. For human-in-the-loop, the user
  has to use approval phases in static workflow OR Director has to give_up
  with a question in the reason.
- No "remember across runs" Director memory yet (the Memory Curator infra
  exists but isn't wired to Director's history).

## Migration / coexistence

Static workflow and Director can **coexist**: a project's workflow can have
Director as one phase or be entirely Director-based. The engine handles
both. Recommend:
1. Keep your existing static workflow on a project.
2. Add a second project (or duplicate the existing one) with a Director-only
   workflow.
3. Run the same ticket on both, compare cost / success / wall-time.
4. After 5-10 tickets, decide.

## How to switch a project to Director mode

Replace the entire `workflow.phases` array with one director phase:

```json
{
  "phases": [
    {
      "id": "director",
      "kind": "director",
      "director": {
        "budget_usd": 10,
        "max_iterations": 12,
        "project_brief": "PHP project, FrankenPHP, composer ci runs in Docker. ...",
        "available_subagents": ["PHP Junior Coder", "PHP Senior Coder", "Reviewer", "DevOps Engineer", "Tester"]
      },
      "next": null
    }
  ],
  "project_specifics": "..."
}
```

Or use the workflow editor: + Add → 🎬 Director, then delete other phases.

## Testing

End-to-end smoke test: take a small ticket (e.g. "add /version endpoint"),
duplicate the project, swap workflow to Director-only, run, compare to
static workflow result.

If Director costs <30% more on simple tickets but recovers gracefully where
static dies (ci_gate hang, retry exhaustion), it's a win.

## Open questions

- **Should Tech Lead remain as a cheap pre-Director gate?** I.e.
  `tech_lead → director`. Tech Lead routes between {static-junior path,
  Director, decompose} based on ticket complexity. Cheaper for trivial
  tickets, full Director only when complex.
- **Should sub-agents see Director's rationale?** Currently they see notes
  only. Adding rationale could help Senior understand "I'm here because
  Junior failed twice on bundles.php" without re-explaining.
- **Recursion: can Director dispatch another Director?** Probably yes for
  decomposed subtickets, but each is its own run today.
