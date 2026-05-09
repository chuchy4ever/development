import { Router } from "express";
import { getStatus, setMaxConcurrent, setMode } from "../scheduler.js";
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
