import type {
  Agent,
  AgentRole,
  ProjectWithRepos,
  ReviewVerdict,
  TestVerdict,
  Ticket,
} from "@ceo/shared";
import { extractFinalText, extractJsonBlock } from "./claude.js";
import type { ClaudeStreamHandlers } from "./claude.js";
import { streamClaude } from "./claude.js";

export interface AgentContext {
  project: ProjectWithRepos;
  ticket: Ticket;
  worktrees: { repo_name: string; path: string }[];
  cwd: string;
  diffs?: string;
  reviewerFeedback?: string;
  /** Workflow-level project_specifics (markdown). */
  projectSpecifics?: string | null;
  /** Phase-level notes (markdown). */
  phaseNotes?: string | null;
  /** Markdown describing who comes before / after this phase in the workflow. */
  pipelineContext?: string | null;
  /** Episodic memory: short bulleted list of the last few succeeded runs in
   *  this project, so the agent knows what was recently done and can avoid
   *  duplicating or contradicting recent work. */
  recentRuns?: string | null;
}

export interface AgentSpec {
  role: AgentRole;
  systemPrompt: string;
  model?: string | null;
  allowedTools?: string[] | null;
  buildPrompt: (ctx: AgentContext) => string;
  parseVerdict?: (finalText: string) => ReviewVerdict | TestVerdict | null;
}

// --- Shared fragments ------------------------------------------------------

function projectContext(ctx: AgentContext): string {
  // Project name, description, spec, tech stack, workflow project_specifics, and
  // project memory live in CLAUDE.md at the run root and are auto-loaded by the
  // claude CLI. We deliberately do NOT repeat them in every per-call prompt to
  // save tokens.
  const { ticket, phaseNotes, pipelineContext, recentRuns } = ctx;
  const recent = recentRuns && recentRuns.trim()
    ? `\n## Recent work in this project (episodic memory)\n${recentRuns}\n`
    : "";
  return `${pipelineContext ? `## Your place in the pipeline\n${pipelineContext}\n\n---\n\n` : ""}# Ticket: ${ticket.title}

${ticket.body || "(no body)"}
${ticket.triage_notes ? `\n## Triage notes\n${ticket.triage_notes}` : ""}
${phaseNotes ? `\n## Phase-specific instructions\n${phaseNotes}` : ""}${recent}`;
}

// --- Coder -----------------------------------------------------------------

const CODER_SYSTEM = `You are a Coder agent on an automated software engineering team.

You operate inside a directory containing one or more git worktrees as subdirectories. Each subdirectory is a normal git repo on a feature branch.

Your job:
- Implement the ticket end-to-end.
- Read, edit, create files freely. Run tests, type-checks, linters via Bash to verify your work.
- COMMIT your changes inside each modified worktree:
    cd <repo_name> && git add -A && git commit -m "<short imperative summary>"
  Multiple commits are fine for logical chunks.
- Do NOT push. Do NOT open PRs. Do NOT touch other repos.
- Match existing conventions. Keep changes minimal and focused.
- Do not add comments explaining obvious code.

When done, end with a 2-4 sentence summary: what you changed, what you verified, anything punted.`;

export const coderAgent: AgentSpec = {
  role: "coder",
  systemPrompt: CODER_SYSTEM,
  buildPrompt: (ctx) => {
    const base = projectContext(ctx);
    const diff = ctx.diffs && ctx.diffs.trim()
      ? `\n\n---\n\n# Current diff (work-in-progress from prior phases)\n\n\`\`\`diff\n${ctx.diffs}\n\`\`\`\n\nReview, then either patch the issues yourself or bounce back via verdict (see your role description).`
      : "";
    const retry = ctx.reviewerFeedback
      ? `\n\n---\n\n# Previous attempt feedback (from a Reviewer or Senior)\n\n${ctx.reviewerFeedback}\n\nAddress these issues in this iteration. You may amend or add commits.`
      : "";
    return `${base}\n\n---\n\nImplement this ticket. Commit your work.${diff}${retry}`;
  },
  // Coder agents may optionally output a verdict (e.g. Senior Coder); if no JSON
  // is found, parseVerdict returns null and the engine treats the phase as ok.
  parseVerdict: (text) => extractJsonBlock<ReviewVerdict>(text),
};

// --- Reviewer --------------------------------------------------------------

const REVIEWER_SYSTEM = `You are a Reviewer agent. You inspect a diff produced by another agent (the Coder) and decide whether it is ready to merge.

You may use Read, Grep, Glob, and Bash (for read-only commands like \`git log\`, \`git show\`, \`git diff\`) to investigate. **Do NOT edit, write, or commit any files.** Do NOT touch the test runner — that is the Tester's job.

Focus your review on:
- Correctness vs. the ticket requirements.
- Hidden bugs, edge cases, security issues, missing error handling at boundaries.
- Tech-stack and convention violations.
- Dead code or unrelated changes that crept in.

When done, output ONLY a JSON object on the LAST line of your response (no fences, no prose around it on that line) with this shape:
{
  "ok": true | false,
  "issues": [
    { "severity": "blocker" | "major" | "minor", "file": "<path>", "line": <number?>, "message": "<short>" }
  ],
  "summary": "<2-4 sentences, plain text>"
}

ok=true means the diff is acceptable to merge. ok=false means there is at least one blocker or major issue. Minor issues alone should NOT set ok=false.`;

export const reviewerAgent: AgentSpec = {
  role: "reviewer",
  systemPrompt: REVIEWER_SYSTEM,
  buildPrompt: (ctx) => {
    const base = projectContext(ctx);
    return `${base}

---

# Diff to review (across all repos in this run)

\`\`\`diff
${ctx.diffs || "(no diff)"}
\`\`\`

---

Review this diff. Investigate as needed (read files, check git history). End with the JSON verdict.`;
  },
  parseVerdict: (text) => extractJsonBlock<ReviewVerdict>(text),
};

// --- Tester ----------------------------------------------------------------

const TESTER_SYSTEM = `You are a Tester agent. You verify that the changes produced by the Coder pass automated checks.

You operate inside a directory containing one or more git worktrees. For each repo, detect the test setup and run it via Bash. Common signals:
- package.json with "test" script → \`npm test\` (also try \`npm run typecheck\`, \`npm run lint\` if defined)
- pnpm-lock.yaml → \`pnpm test\`
- Cargo.toml → \`cargo test\`
- go.mod → \`go test ./...\`
- pyproject.toml → \`pytest\` or \`python -m pytest\`

If a repo has no obvious tests, note it but do not fail. Do NOT install new dependencies. Run only commands that are already part of the project's defined scripts/tooling.

Do NOT edit any files. Do NOT commit.

When done, output ONLY a JSON object on the LAST line:
{
  "ok": true | false,
  "ran": ["<command1>", "<command2>", ...],
  "summary": "<2-4 sentences: what you ran, results, any failures>"
}

ok=false means at least one command failed.`;

export const testerAgent: AgentSpec = {
  role: "tester",
  systemPrompt: TESTER_SYSTEM,
  buildPrompt: (ctx) =>
    `${projectContext(ctx)}

---

Detect and run the appropriate tests / type-checks / linters in each repo. End with the JSON verdict.`,
  parseVerdict: (text) => extractJsonBlock<TestVerdict>(text),
};

/** Build an AgentSpec from a stored Agent record. */
export function specFromAgent(agent: Agent): AgentSpec {
  const base = getAgent(agent.role);
  return {
    role: agent.role,
    systemPrompt: agent.system_prompt || base.systemPrompt,
    model: agent.model ?? null,
    allowedTools: agent.allowed_tools ?? null,
    buildPrompt: base.buildPrompt,
    parseVerdict: base.parseVerdict,
  };
}

// --- Runner ----------------------------------------------------------------

export interface AgentRunResult {
  exitCode: number;
  finalText: string;
  verdict: ReviewVerdict | TestVerdict | null;
}

export function getAgent(role: AgentRole): AgentSpec {
  switch (role) {
    case "coder": return coderAgent;
    case "reviewer": return reviewerAgent;
    case "tester": return testerAgent;
  }
}

export async function runAgent(
  agent: AgentSpec,
  ctx: AgentContext,
  handlers: ClaudeStreamHandlers,
  /** Called synchronously right after the child process is spawned, with the
   *  cancel handle. Lets the caller register cancellation before awaiting. */
  registerCancel?: (cancel: () => void) => void,
): Promise<AgentRunResult & { cancel: () => void }> {
  const prompt = agent.buildPrompt(ctx);
  let stdoutBuf = "";
  const wrapped: ClaudeStreamHandlers = {
    ...handlers,
    onLine: (line) => {
      stdoutBuf += line + "\n";
      handlers.onLine?.(line);
    },
  };
  const { promise, cancel } = streamClaude(
    {
      prompt,
      systemPrompt: agent.systemPrompt,
      cwd: ctx.cwd,
      model: agent.model ?? undefined,
      allowedTools: agent.allowedTools ?? undefined,
    },
    wrapped,
  );
  registerCancel?.(cancel);
  const res = await promise;
  const finalText = extractFinalText(stdoutBuf);
  let verdict = agent.parseVerdict ? agent.parseVerdict(finalText) : null;
  // If parser failed on the result field alone, try the full transcript.
  if (agent.parseVerdict && !verdict) {
    verdict = agent.parseVerdict(stdoutBuf);
  }
  return { exitCode: res.exitCode, finalText, verdict, cancel };
}
