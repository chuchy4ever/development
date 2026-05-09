import { extractFinalText, extractJsonBlock } from "./claude.js";

export function safeParseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/**
 * Try to pull a JSON object from a claude transcript. Prefer the parsed
 * "result" field; fall back to scanning the full stdout if that didn't yield
 * an object — robust to agents that drop the JSON in an assistant message
 * without echoing it in the result.
 */
export function extractJsonWithFallback<T>(stdout: string): T | null {
  const finalText = extractFinalText(stdout);
  return extractJsonBlock<T>(finalText) ?? extractJsonBlock<T>(stdout);
}
