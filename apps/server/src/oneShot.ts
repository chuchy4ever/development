import { runClaude } from "./claude.js";
import type { ClaudeResult } from "./claude.js";

export interface OneShotAgentSpec {
  system_prompt: string;
  model?: string | null;
  allowed_tools?: string[] | null;
}

/**
 * Run a non-workflow agent (Triage, CTO, Memory Curator) as a single claude
 * invocation. Throws on non-zero exit.
 */
export async function runAgentOneShot(
  agent: OneShotAgentSpec,
  prompt: string,
  cwd?: string,
): Promise<ClaudeResult> {
  const res = await runClaude({
    prompt,
    systemPrompt: agent.system_prompt,
    cwd,
    model: agent.model ?? undefined,
    allowedTools: agent.allowed_tools ?? undefined,
    json: false,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `agent failed (exit ${res.exitCode}): ${res.stderr || res.stdout.slice(0, 500)}`,
    );
  }
  return res;
}
