import type { ProjectWithRepos, Ticket } from "@ceo/shared";
import { runAgentOneShot } from "./oneShot.js";
import { extractCostFromStdout, recordCost } from "./costLog.js";
import { extractJsonWithFallback } from "./jsonUtil.js";

export interface TriageOutput {
  priority: "P0" | "P1" | "P2" | "P3";
  workflow_template: "feature" | "bugfix" | "change_request" | "spike";
  repos_touched: string[];
  notes: string;
}

const SYSTEM_PROMPT = `You are a Triage agent for a software engineering workflow tool.

You receive:
- A project description, tech stack, and the list of available repos.
- A raw ticket (title + free-text body) written by a developer.

Your job:
- Classify the ticket and propose how the team should work on it.
- Be terse. Do NOT write code. Do NOT plan implementation. Just classify.

Output ONLY a JSON object (no prose, no fences) with EXACTLY these keys:
{
  "priority": "P0" | "P1" | "P2" | "P3",
  "workflow_template": "feature" | "bugfix" | "change_request" | "spike",
  "repos_touched": [<repo names from the provided list>],
  "notes": "<2-4 short sentences: what this ticket is about, key risks, any open questions>"
}

Priority rules:
- P0: production down / data loss / security
- P1: blocking work or user-visible bug
- P2: standard feature work (default)
- P3: nice-to-have, polish

Workflow rules:
- feature: new capability
- bugfix: something is broken
- change_request: modifies an in-progress or recently shipped ticket
- spike: research / investigation, output is a doc not code

Repos: pick only from the provided list. If unclear, pick the most likely subset.`;

export async function runTriage(
  project: ProjectWithRepos,
  ticket: Ticket,
): Promise<TriageOutput> {
  const repoList = project.repos.map((r) => `- ${r.name}: ${r.url}`).join("\n") || "(no repos configured)";
  const prompt = `# Project: ${project.name}

${project.description || "(no description)"}

## Spec
${project.spec_md || "(no spec)"}

## Tech stack
${project.tech_stack_md || "(no tech stack notes)"}

## Available repos
${repoList}

---

# Ticket
**Title:** ${ticket.title}

**Body:**
${ticket.body || "(no body)"}

---

Classify this ticket. Return JSON only.`;

  const res = await runAgentOneShot(
    { system_prompt: SYSTEM_PROMPT, allowed_tools: [] },
    prompt,
  );
  recordCost({
    source: "triage",
    cost_usd: extractCostFromStdout(res.stdout),
    project_id: project.id,
  });
  const parsed = extractJsonWithFallback<TriageOutput>(res.stdout);
  if (!parsed) {
    throw new Error(`Triage returned unparseable output: ${res.stdout.slice(0, 500)}`);
  }

  // Validate + normalize.
  const validRepos = new Set(project.repos.map((r) => r.name));
  const repos_touched = (parsed.repos_touched ?? []).filter((r) => validRepos.has(r));

  return {
    priority: parsed.priority ?? "P2",
    workflow_template: parsed.workflow_template ?? "feature",
    repos_touched,
    notes: parsed.notes ?? "",
  };
}
