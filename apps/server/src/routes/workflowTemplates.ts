import { Router } from "express";
import {
  applyTemplate,
  deleteUserTemplate,
  getTemplate,
  listTemplates,
  saveProjectAsTemplate,
} from "../workflowTemplates.js";

export const workflowTemplatesRouter = Router();

workflowTemplatesRouter.get("/", (_req, res) => {
  res.json(listTemplates());
});

workflowTemplatesRouter.get("/:key", (req, res) => {
  const t = getTemplate(req.params.key);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json(t);
});

workflowTemplatesRouter.delete("/:key", (req, res) => {
  const ok = deleteUserTemplate(req.params.key);
  if (!ok) {
    return res.status(400).json({
      error: "cannot delete: not found, or it's a built-in template",
    });
  }
  res.status(204).end();
});

// POST /api/projects/:projectId/save-as-template
// body: { key, name, description? }
export const projectSaveAsTemplateRouter = Router({ mergeParams: true });

projectSaveAsTemplateRouter.post("/save-as-template", (req, res) => {
  const projectId = (req.params as any).projectId as string;
  const { key, name, description } = req.body ?? {};
  if (!key || !name) {
    return res.status(400).json({ error: "key and name are required" });
  }
  try {
    const tpl = saveProjectAsTemplate({ projectId, key, name, description });
    res.status(201).json(tpl);
  } catch (e: any) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

// POST /api/projects/:projectId/apply-template/:key
projectSaveAsTemplateRouter.post("/apply-template/:key", (req, res) => {
  const projectId = (req.params as any).projectId as string;
  const key = req.params.key;
  try {
    const result = applyTemplate(projectId, key);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message || String(e) });
  }
});
