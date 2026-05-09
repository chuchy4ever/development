/**
 * Compute a short uppercase prefix from a project name.
 * - Single-word names → first 3 alphanumeric chars (e.g. "Agarden" → "AGA").
 * - Multi-word names → initials, max 4 chars (e.g. "Recepty kuchařka" → "RK").
 * - Diacritics stripped. Falls back to "TKT" for empty/unprintable names.
 */
export function computeKeyPrefix(name: string): string {
  const COMBINING = new RegExp("[̀-ͯ]", "g");
  const stripped = name.normalize("NFD").replace(COMBINING, "");
  const words = stripped.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "TKT";
  if (words.length === 1) {
    const w = words[0]!.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return w.slice(0, 3) || "TKT";
  }
  const initials = words
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return initials.slice(0, 4) || "TKT";
}

export function buildTicketKey(prefix: string, seq: number): string {
  return `${prefix || "TKT"}-${seq}`;
}
