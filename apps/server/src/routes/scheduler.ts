import { Router } from "express";
import { getStatus, setMaxConcurrent, setMode, setPauseAfter } from "../scheduler.js";
import type { SchedulerMode } from "@ceo/shared";

export const schedulerRouter = Router();

schedulerRouter.get("/", (_req, res) => {
  res.json(getStatus());
});

schedulerRouter.post("/mode", (req, res) => {
  const mode = (req.body?.mode ?? "") as SchedulerMode;
  if (mode !== "paused" && mode !== "running") {
    return res.status(400).json({ error: "mode must be 'paused' or 'running'" });
  }
  res.json(setMode(mode));
});

schedulerRouter.post("/max-concurrent", (req, res) => {
  const n = Number(req.body?.value);
  if (!Number.isFinite(n)) {
    return res.status(400).json({ error: "value must be a number" });
  }
  res.json(setMaxConcurrent(n));
});

/** Schedule an auto-pause. Accepts either an ISO timestamp (`pause_at`) or a
 *  delay in seconds from now (`delay_seconds`). Pass null/0 to clear.
 *  Scheduler keeps running new starts until the deadline; after that the mode
 *  flips to "paused" and in-flight runs drain naturally. */
schedulerRouter.post("/pause-after", (req, res) => {
  const body = req.body as { pause_at?: string | null; delay_seconds?: number | null } | undefined;
  let iso: string | null = null;
  if (body?.pause_at && typeof body.pause_at === "string") {
    const d = new Date(body.pause_at);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "pause_at: invalid ISO timestamp" });
    iso = d.toISOString();
  } else if (typeof body?.delay_seconds === "number" && body.delay_seconds > 0) {
    iso = new Date(Date.now() + body.delay_seconds * 1000).toISOString();
  }
  res.json(setPauseAfter(iso));
});
