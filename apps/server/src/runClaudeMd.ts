import path from "node:path";
import fs from "node:fs";
import type { ProjectWithRepos } from "@ceo/shared";
import { readMemory } from "./projectMemory.js";

/**
 * Build the CLAUDE.md content for a run. Claude CLI auto-loads CLAUDE.md from
 * cwd, so writing this file once at the run root means every agent invocation
 * sees this context without us paying for it in the per-call -p prompt.
 */
export function buildRunClaudeMd(args: {
  project: ProjectWithRepos;
  projectSpecifics?: string | null;
}): string {
  const { project, projectSpecifics } = args;
  const memory = readMemory(project.id).trim();

  const sections: string[] = [];

  sections.push(`# ${project.name}`);
  if (project.description?.trim()) {
    sections.push(project.description.trim());
  }

  if (project.spec_md?.trim()) {
    sections.push(`## Spec\n\n${project.spec_md.trim()}`);
  }

  if (project.tech_stack_md?.trim()) {
    sections.push(`## Tech stack\n\n${project.tech_stack_md.trim()}`);
  }

  if (projectSpecifics?.trim()) {
    sections.push(`## Workflow-wide instructions\n\n${projectSpecifics.trim()}`);
  }

  if (memory) {
    sections.push(`## Project memory

Long-lived knowledge accumulated across runs. Read this carefully — it captures conventions, gotchas, and prior decisions that the team should not re-discover.

${memory}`);
  }

  if (project.repos.length > 0) {
    const list = project.repos.map((r) => `- \`${r.name}\` (default branch: \`${r.default_branch}\`)`).join("\n");
    sections.push(`## Repos in this run\n\nEach repo is a git worktree subdirectory of the current directory.\n${list}`);
  }

  sections.push(`## Operating rules

- Commit your work inside the appropriate worktree subdirectory before finishing your turn.
- Do NOT push, do NOT open PRs — the orchestrator handles those.
- The pipeline context section in your per-call prompt tells you who handed off to you and who runs after you.`);

  return sections.join("\n\n") + "\n";
}

export function writeRunClaudeMd(runRoot: string, content: string): void {
  fs.mkdirSync(runRoot, { recursive: true });
  const target = path.join(runRoot, "CLAUDE.md");
  // Skip the write when content is unchanged — saves a touch of disk I/O and
  // (more importantly) keeps mtime stable so claude CLI's caching can detect
  // no-change between runs.
  if (fs.existsSync(target)) {
    try {
      if (fs.readFileSync(target, "utf8") === content) return;
    } catch {}
  }
  fs.writeFileSync(target, content, "utf8");
}
