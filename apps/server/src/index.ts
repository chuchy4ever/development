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

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
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

backfillAllProjects();
backfillTicketKeys();
void resumeOrphanedRuns();
startScheduler();

// Periodic worktree cleanup: cancelled runs older than 12h, failed older than 7d.
void cleanupOldRunArtifacts();
setInterval(() => { void cleanupOldRunArtifacts(); }, 6 * 60 * 60 * 1000); // every 6h

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server error]", err);
  res.status(500).json({ error: err?.message || "internal error" });
});

app.listen(PORT, () => {
  console.log(`[ceo] server listening on http://localhost:${PORT}`);
  // Telegram bot is opt-in; only fires if TELEGRAM_BOT_TOKEN is set.
  startTelegramBot();
});
