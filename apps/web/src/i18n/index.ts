/**
 * Lightweight i18n — string table + tiny `t()` function. Keys are stable
 * dot-paths; values are short strings. Missing keys fall back to the key
 * itself, so the app keeps working while translations are being filled in.
 *
 * Add a string:
 *   1. Pick a key (e.g. "playbook.specialists.title")
 *   2. Add it to both en.ts and cs.ts
 *   3. Use t("playbook.specialists.title") in JSX
 */

import { en } from "./en";
import { cs } from "./cs";
import { useEffect, useState } from "react";

export type Lang = "cs" | "en";

const TABLES: Record<Lang, Record<string, string>> = { cs, en };

const STORAGE_KEY = "ceo.lang";

/** Module-level current language. UI components read this via useLang() so
 *  changing it triggers re-render via a custom event. */
let currentLang: Lang = (
  (typeof localStorage !== "undefined" && (localStorage.getItem(STORAGE_KEY) as Lang | null)) || "cs"
);

const LISTENERS = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return currentLang;
}

export function setLang(l: Lang): void {
  if (l === currentLang) return;
  currentLang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch { /* ignore quota / private mode */ }
  LISTENERS.forEach((fn) => fn(l));
}

/** Simple `t(key, params?)` — looks up the key in the current language's
 *  table, optionally interpolates `{name}`-style placeholders. Falls back to
 *  the English entry if missing in the active language; falls back to the
 *  key itself if missing in both. */
export function t(key: string, params?: Record<string, string | number>): string {
  const tbl = TABLES[currentLang];
  let raw = tbl[key];
  if (raw === undefined) raw = TABLES.en[key];
  if (raw === undefined) raw = key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

/** React hook — components subscribe and re-render on language change. */
export function useLang(): [Lang, (l: Lang) => void] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((x) => x + 1);
    LISTENERS.add(fn);
    return () => { LISTENERS.delete(fn); };
  }, []);
  return [currentLang, setLang];
}
