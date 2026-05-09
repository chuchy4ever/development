import path from "node:path";
import fs from "node:fs";
import { PROJECTS_DIR } from "./config.js";
import { applyMemoryUpdateText } from "./memoryUtil.js";
import type { MemoryUpdate, MemoryUpdateResult } from "./memoryUtil.js";

const MAX_LINES = 30;

export type { MemoryUpdate, MemoryUpdateResult };

export function agentMemoryPath(projectId: string, agentId: string): string {
  return path.join(PROJECTS_DIR, projectId, "agents", agentId, "MEMORY.md");
}

export function readAgentMemory(projectId: string, agentId: string): string {
  const p = agentMemoryPath(projectId, agentId);
  if (!fs.existsSync(p)) return "";
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

export function writeAgentMemory(projectId: string, agentId: string, content: string): void {
  const p = agentMemoryPath(projectId, agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

export function deleteAgentMemory(projectId: string, agentId: string): void {
  const p = agentMemoryPath(projectId, agentId);
  if (fs.existsSync(p)) {
    try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch {}
  }
}

export function applyMemoryUpdate(
  projectId: string,
  agentId: string,
  update: MemoryUpdate,
): MemoryUpdateResult {
  const result = applyMemoryUpdateText(readAgentMemory(projectId, agentId), update, MAX_LINES);
  if (result.added > 0 || result.removed > 0 || result.capped > 0) {
    writeAgentMemory(projectId, agentId, result.final_text);
  }
  return result;
}
