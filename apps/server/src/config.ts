import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const DATA_DIR = process.env.CEO_DATA_DIR ?? path.join(os.homedir(), ".ceo");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const DB_PATH = path.join(DATA_DIR, "ceo.db");

export const CLAUDE_BIN =
  process.env.CEO_CLAUDE_BIN ??
  // Default to PATH lookup; user can override via env if needed.
  "claude";

export const PORT = Number(process.env.PORT ?? 4000);

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}
