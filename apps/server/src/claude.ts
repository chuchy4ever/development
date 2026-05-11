import { spawn } from "node:child_process";
import { CLAUDE_BIN } from "./config.js";

export interface ClaudeRunOptions {
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  // If true, use --output-format json (single JSON result). Otherwise stream-json.
  json?: boolean;
}

export interface ClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ClaudeStreamHandlers {
  onLine?: (line: string) => void;       // one parsed stream-json line
  onStderr?: (chunk: string) => void;
  onExit?: (code: number) => void;
}

/**
 * Spawn claude with stream-json output, parse line-by-line, invoke handlers.
 * Returns a controller with cancel().
 */
export function streamClaude(
  opts: ClaudeRunOptions,
  handlers: ClaudeStreamHandlers,
): { promise: Promise<ClaudeResult>; cancel: () => void } {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Run unattended: skip permission prompts. The agent still cannot escape
    // the cwd (worktree), and the user is supposed to review before merge.
    "--dangerously-skip-permissions",
  ];
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowed-tools", opts.allowedTools.join(","));
  }

  const child = spawn(CLAUDE_BIN, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length > 0 && handlers.onLine) handlers.onLine(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stderr += s;
    handlers.onStderr?.(s);
  });

  const promise = new Promise<ClaudeResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      // Flush any trailing partial line.
      if (buf.trim().length > 0 && handlers.onLine) handlers.onLine(buf);
      const exit = code ?? -1;
      handlers.onExit?.(exit);
      resolve({ exitCode: exit, stdout, stderr });
    });
  });

  return {
    promise,
    cancel: () => {
      try { child.kill("SIGTERM"); } catch {}
    },
  };
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeResult> {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    opts.json ? "json" : "stream-json",
    "--verbose",
  ];
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowed-tools", opts.allowedTools.join(","));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Parse a stream-json transcript and return just the final assistant text.
 * stream-json emits one JSON object per line. We pick the last "result" event
 * if present, otherwise concatenate "assistant" message text.
 */
export function extractFinalText(streamJsonStdout: string): string {
  const lines = streamJsonStdout.split("\n").filter((l) => l.trim().length > 0);
  let result = "";
  let assistantConcat = "";
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "result" && typeof obj.result === "string") {
        result = obj.result;
      } else if (obj.type === "assistant" && obj.message?.content) {
        for (const c of obj.message.content) {
          if (c.type === "text" && typeof c.text === "string") {
            assistantConcat += c.text;
          }
        }
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
  return result || assistantConcat;
}

/**
 * Try to extract a JSON object from agent output. Strategy:
 *   1. If a ```json fenced block exists, parse the content of the last one.
 *   2. Else, try parsing first-{ to last-} (handles "Here's the JSON: {...}" prose).
 *   3. Else, scan from the END backward for the last balanced {...} block
 *      (handles agents that output JSON on the LAST line, after other prose
 *      that happens to contain {} themselves).
 * Returns null only if none of the strategies parse.
 */
export function extractJsonBlock<T = unknown>(text: string): T | null {
  // 1. Last fenced ```json``` block.
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let lastFence: RegExpExecArray | null = null;
  for (let m: RegExpExecArray | null; (m = fenceRe.exec(text)); ) lastFence = m;
  if (lastFence) {
    const parsed = tryParse<T>(lastFence[1]!);
    if (parsed !== null) return parsed;
  }

  // 2. Greedy first-{ to last-}.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParse<T>(text.slice(firstBrace, lastBrace + 1));
    if (parsed !== null) return parsed;
  }

  // 3. Scan backward for the last balanced { ... } block.
  for (let end = text.lastIndexOf("}"); end !== -1; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          const parsed = tryParse<T>(text.slice(i, end + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}
