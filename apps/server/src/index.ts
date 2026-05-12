import express from "express";
import cors from "cors";
import { PORT } from "./config.js";
import { projectsRouter } from "./routes/projects.js";
import { ticketsRouter } from "./routes/tickets.js";
import { runsRouter } from "./routes/runs.js";
import { schedulerRouter } from "./routes/scheduler.js";
import { agentsRouter, agentTemplatesRouter } from "./routes/agents.js";
import { workflowTemplatesRouter, projectSaveAsTemplateRouter } from "./routes/workflowTemplates.js";
import { adminRouter } from "./routes/admin.js";
import { startScheduler } from "./scheduler.js";
import { backfillAllProjects } from "./seedAgents.js";
import { backfillTicketKeys } from "./backfillTicketKeys.js";
import { cleanupOldRunArtifacts, resumeOrphanedRuns } from "./runs.js";
import { startTelegramBot } from "./telegramBot.js";
import { jobsRouter, jobRunsRouter } from "./routes/jobs.js";
import { startScheduledJobs, pruneOldJobRuns } from "./scheduledJobs.js";
import { getGlobalSecret } from "./globalSecrets.js";
import { TELEGRAM_BOT_TOKEN } from "./config.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Telegram connectivity status — surfaced in the UI next to the NotificationsBell
// so the user can tell at a glance whether the bot will actually deliver.
// Reads through getGlobalSecret so DB-set values reflect immediately (no
// restart needed for the chip to flip green); long-poll bot connection itself
// still needs a restart to pick up a new token.
app.get("/api/health/telegram", (_req, res) => {
  const botToken = getGlobalSecret("telegram_bot_token");
  const outputChat = getGlobalSecret("telegram_output_chat_id");
  const allowedRaw = getGlobalSecret("telegram_allowed_user_ids");
  const allowedCount = allowedRaw.split(",").map((s) => s.trim()).filter(Boolean).length;
  res.json({
    bot_token_set: botToken.length > 0,
    output_chat_id_set: outputChat.length > 0,
    allowed_users_count: allowedCount,
    // True only when the long-poll bot booted with a token at server startup.
    // DB-set token won't activate the bot until restart.
    bot_running: TELEGRAM_BOT_TOKEN.length > 0,
  });
});

app.use("/api/projects", projectsRouter);
app.use("/api/projects/:projectId/tickets", ticketsRouter);
app.use("/api/projects/:projectId/agents", agentsRouter);
app.use("/api/agent-templates", agentTemplatesRouter);
app.use("/api/workflow-templates", workflowTemplatesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/projects/:projectId", projectSaveAsTemplateRouter);
app.use("/api", runsRouter);
app.use("/api/scheduler", schedulerRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/job-runs", jobRunsRouter);

backfillAllProjects();
backfillTicketKeys();
void resumeOrphanedRuns();
startScheduler();
startScheduledJobs();

// Periodic worktree cleanup: cancelled runs older than 12h, failed older than 7d.
void cleanupOldRunArtifacts();
setInterval(() => { void cleanupOldRunArtifacts(); }, 6 * 60 * 60 * 1000); // every 6h

// Daily prune of job_runs (90-day retention). Watch jobs at 30s ticks can
// produce thousands of rows/day; without this the table + details_json blob
// grow unbounded.
pruneOldJobRuns();
setInterval(() => { pruneOldJobRuns(); }, 24 * 60 * 60 * 1000);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server error]", err);
  res.status(500).json({ error: err?.message || "internal error" });
});

app.listen(PORT, () => {
  console.log(`[ceo] server listening on http://localhost:${PORT}`);
  // Telegram bot is opt-in; only fires if TELEGRAM_BOT_TOKEN is set.
  startTelegramBot();
});
