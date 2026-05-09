export interface MemoryUpdate {
  add?: string[];
  remove_matching?: string[];
}

export interface MemoryUpdateResult {
  added: number;
  removed: number;
  capped: number;
  final_lines: number;
  final_text: string;
}

/**
 * Apply add/remove operations to a list of memory lines, with dedupe + cap.
 * Returns the new list as text plus stats. Caller persists the text wherever
 * it stores its memory file.
 */
export function applyMemoryUpdateText(
  current: string,
  update: MemoryUpdate,
  maxLines: number,
): MemoryUpdateResult {
  let lines = current
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);

  let removed = 0;
  if (Array.isArray(update.remove_matching) && update.remove_matching.length > 0) {
    const patterns = update.remove_matching
      .map((p) => p.toLowerCase().trim())
      .filter(Boolean);
    if (patterns.length > 0) {
      const before = lines.length;
      lines = lines.filter(
        (l) => !patterns.some((pat) => l.toLowerCase().includes(pat)),
      );
      removed = before - lines.length;
    }
  }

  let added = 0;
  if (Array.isArray(update.add) && update.add.length > 0) {
    const seen = new Set(lines);
    for (const raw of update.add) {
      const line = String(raw).replace(/\s+$/, "").trim();
      if (!line || seen.has(line)) continue;
      lines.push(line);
      seen.add(line);
      added++;
    }
  }

  let capped = 0;
  if (lines.length > maxLines) {
    capped = lines.length - maxLines;
    lines = lines.slice(-maxLines);
  }

  return {
    added,
    removed,
    capped,
    final_lines: lines.length,
    final_text: lines.length > 0 ? lines.join("\n") + "\n" : "",
  };
}
