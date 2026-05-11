import { t } from "../i18n";

/** "5 min ago", "2h ago", "3d ago" — based on i18n keys (cs/en aware). */
export function formatRelativeAge(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return t("age.just_now");
  if (m < 60) return t("age.minutes", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("age.hours", { n: h });
  const d = Math.floor(h / 24);
  return t("age.days", { n: d });
}

/** Compact wall-time formatter: 350 ms → "0s", 12_345 ms → "12s",
 *  90_000 ms → "1m 30s", 3_900_000 ms → "1h 5m". Used for run rollups. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${hr}h ${rem}m` : `${hr}h`;
}

/** Convert a git remote URL to a web URL on the platform's UI. Returns null
 *  if we can't recognise the host or the URL is malformed.
 *    git@gitlab.com:foo/bar.git    → https://gitlab.com/foo/bar
 *    https://gitlab.com/foo/bar.git → https://gitlab.com/foo/bar
 *    git@github.com:foo/bar.git    → https://github.com/foo/bar
 */
export function gitRemoteToWebUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return `https://${https[1]}/${https[2]}`;
  return null;
}

/** Build a deep link to a branch in the platform's UI. GitLab uses /-/tree/,
 *  GitHub uses /tree/. Returns null when the host isn't recognised. */
export function gitBranchWebUrl(remote: string | null | undefined, branch: string): string | null {
  const web = gitRemoteToWebUrl(remote);
  if (!web) return null;
  if (web.includes("gitlab.")) return `${web}/-/tree/${branch}`;
  if (web.includes("github.") || web.includes("bitbucket.")) return `${web}/tree/${branch}`;
  // Generic fallback — fine for most self-hosted git platforms.
  return `${web}/tree/${branch}`;
}
