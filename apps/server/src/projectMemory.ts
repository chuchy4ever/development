import path from "node:path";
import fs from "node:fs";
import { PROJECTS_DIR } from "./config.js";
import { applyMemoryUpdateText } from "./memoryUtil.js";
import type { MemoryUpdate, MemoryUpdateResult } from "./memoryUtil.js";

const PROJECT_MEMORY_MAX_LINES = 100;

export type ProjectMemoryUpdate = MemoryUpdate;
export type ProjectMemoryUpdateResult = MemoryUpdateResult;

export function memoryPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, "MEMORY.md");
}

export function readMemory(projectId: string): string {
  const p = memoryPath(projectId);
  if (!fs.existsSync(p)) return "";
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

export function writeMemory(projectId: string, content: string): void {
  const p = memoryPath(projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

export function applyProjectMemoryUpdate(
  projectId: string,
  update: ProjectMemoryUpdate,
): ProjectMemoryUpdateResult {
  const result = applyMemoryUpdateText(readMemory(projectId), update, PROJECT_MEMORY_MAX_LINES);
  if (result.added > 0 || result.removed > 0 || result.capped > 0) {
    writeMemory(projectId, result.final_text);
  }
  return result;
}
