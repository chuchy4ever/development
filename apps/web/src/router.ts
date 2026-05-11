import { useEffect, useState } from "react";

export type Tab = "board" | "agents" | "workflow" | "memory" | "jobs" | "settings";
export type AdminSection = "overview" | "templates" | "activity" | "jobs" | "jobruns" | "connectors";

export interface Route {
  view: "project" | "admin";
  projectId: string | null;
  tab: Tab;
  ticketId: string | null;
  adminSection: AdminSection;
}

const DEFAULT: Route = {
  view: "project",
  projectId: null,
  tab: "board",
  ticketId: null,
  adminSection: "overview",
};

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "/");

  // Admin
  const adm = path.match(/^\/admin(?:\/(overview|templates|activity|jobs|jobruns|connectors))?\/?$/);
  if (adm) {
    return {
      ...DEFAULT,
      view: "admin",
      adminSection: (adm[1] as AdminSection | undefined) ?? "overview",
    };
  }

  // Project
  const m = path.match(
    /^\/projects\/([^/]+)(?:\/(board|agents|workflow|memory|jobs|settings))?(?:\/tickets\/([^/]+))?\/?$/,
  );
  if (m) {
    return {
      ...DEFAULT,
      view: "project",
      projectId: m[1] ?? null,
      tab: (m[2] as Tab | undefined) ?? "board",
      ticketId: m[3] ?? null,
    };
  }

  return DEFAULT;
}

export function buildHash(r: Partial<Route>): string {
  const merged = { ...DEFAULT, ...r };
  if (merged.view === "admin") {
    return `/admin/${merged.adminSection}`;
  }
  if (!merged.projectId) return "/";
  const base = `/projects/${merged.projectId}/${merged.tab}`;
  return merged.ticketId ? `${base}/tickets/${merged.ticketId}` : base;
}

export function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = (next: Partial<Route>) => {
    const merged: Route = {
      view: next.view !== undefined ? next.view : route.view,
      projectId: next.projectId !== undefined ? next.projectId : route.projectId,
      tab: next.tab !== undefined ? next.tab : route.tab,
      ticketId: next.ticketId !== undefined ? next.ticketId : route.ticketId,
      adminSection: next.adminSection !== undefined ? next.adminSection : route.adminSection,
    };
    const newHash = `#${buildHash(merged)}`;
    if (newHash !== window.location.hash) {
      window.location.hash = newHash;
    }
  };

  return [route, navigate];
}
