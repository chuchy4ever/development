import type {
  ActiveRunSummary,
  Agent,
  AgentTemplate,
  ApplyTemplateResult,
  BulkImportInput,
  WorkflowPreset,
  BulkImportResult,
  CreateAgentInput,
  CreateProjectInput,
  CreateRepoInput,
  CreateTicketInput,
  Project,
  ProjectWithRepos,
  Run,
  RunUserVerdict,
  RunEvent,
  ConnectorHealthRow,
  SchedulerMode,
  SchedulerStatus,
  Ticket,
  WorkflowDefinition,
  ScheduledJob,
  CreateScheduledJobInput,
  UpdateScheduledJobInput,
  JobRun,
} from "@ceo/shared";

/** UI-safe representation of one project secret/config entry. The full
 *  plaintext value never leaves the server — `display` is masked for token-
 *  typed entries (last 4 chars) and full text for non-secret config. */
export interface ProjectSecretMasked {
  key: string;
  label: string;
  secret: boolean;
  hint?: string;
  source: "project" | "env" | "unset";
  display: string;
  has_project_value: boolean;
  updated_at: string | null;
}

async function req<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listProjects: () => req<Project[]>("/api/projects"),
  projectsSummary: () =>
    req<Array<{ id: string; active_runs: number; backlog_count: number; today_cost_usd: number }>>(
      "/api/projects/summary",
    ),
  getProject: (id: string) => req<ProjectWithRepos>(`/api/projects/${id}`),
  createProject: (input: CreateProjectInput) =>
    req<ProjectWithRepos>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProject: (id: string, input: Partial<CreateProjectInput>) =>
    req<ProjectWithRepos>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteProject: (id: string) =>
    req<void>(`/api/projects/${id}`, { method: "DELETE" }),

  addRepo: (projectId: string, input: CreateRepoInput) =>
    req<ProjectWithRepos>(`/api/projects/${projectId}/repos`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeRepo: (projectId: string, repoId: string) =>
    req<ProjectWithRepos>(`/api/projects/${projectId}/repos/${repoId}`, {
      method: "DELETE",
    }),

  listProjectSecrets: (projectId: string) =>
    req<ProjectSecretMasked[]>(`/api/projects/${projectId}/secrets`),
  setProjectSecret: (projectId: string, key: string, value: string) =>
    req<ProjectSecretMasked[]>(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteProjectSecret: (projectId: string, key: string) =>
    req<ProjectSecretMasked[]>(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  testProjectSecretGroup: (projectId: string, group: "github" | "jira" | "ssh") =>
    req<{ ok: boolean; message: string }>(`/api/projects/${projectId}/secrets/${group}/test`, {
      method: "POST",
    }),
  copyDefaultSecretToProject: (projectId: string, key: string) =>
    req<ProjectSecretMasked[]>(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}/copy-from-default`, {
      method: "POST",
    }),

  // Global (admin-level) secrets — paralelní s project secrets, používané pro
  // globální joby a jako fallback pro projekty s prázdným polem.
  listGlobalSecrets: () =>
    req<ProjectSecretMasked[]>(`/api/admin/secrets`),
  setGlobalSecret: (key: string, value: string) =>
    req<ProjectSecretMasked[]>(`/api/admin/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteGlobalSecret: (key: string) =>
    req<ProjectSecretMasked[]>(`/api/admin/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  testGlobalSecretGroup: (group: "github" | "jira" | "ssh") =>
    req<{ ok: boolean; message: string }>(`/api/admin/secrets/${group}/test`, {
      method: "POST",
    }),
  globalConnectorHealth: () =>
    req<ConnectorHealthRow[]>(`/api/admin/connector-health`),
  projectConnectorHealth: (projectId: string) =>
    req<ConnectorHealthRow[]>(`/api/projects/${projectId}/connector-health`),

  listTickets: (projectId: string) =>
    req<Ticket[]>(`/api/projects/${projectId}/tickets`),
  createTicket: (projectId: string, input: CreateTicketInput) =>
    req<Ticket>(`/api/projects/${projectId}/tickets`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTicket: (projectId: string, ticketId: string, input: Partial<Ticket>) =>
    req<Ticket>(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteTicket: (projectId: string, ticketId: string) =>
    req<void>(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "DELETE",
    }),
  triageTicket: (projectId: string, ticketId: string) =>
    req<Ticket>(`/api/projects/${projectId}/tickets/${ticketId}/triage`, {
      method: "POST",
    }),
  decomposeTicket: (projectId: string, ticketId: string) =>
    req<{ decomposed: boolean; rationale: string; created: Ticket[] }>(
      `/api/projects/${projectId}/tickets/${ticketId}/decompose`,
      { method: "POST" },
    ),

  startRun: (projectId: string, ticketId: string) =>
    req<Run>(`/api/projects/${projectId}/tickets/${ticketId}/runs`, {
      method: "POST",
    }),
  getRun: (runId: string) => req<Run>(`/api/runs/${runId}`),
  listActiveRuns: (projectId: string) =>
    req<ActiveRunSummary[]>(`/api/projects/${projectId}/active-runs`),
  getProjectStats: (projectId: string) =>
    req<{
      runs_total: number;
      runs_by_status: Record<string, number>;
      total_cost_usd: number;
      today_cost_usd: number;
      last_7_days_cost_usd: number;
      total_runtime_ms: number;
      avg_cost_per_run_usd: number;
      tickets_by_status: Record<string, number>;
      tickets_total: number;
      estimated_saved_hours: number;
    }>(`/api/projects/${projectId}/stats`),
  listTicketRuns: (ticketId: string) =>
    req<Run[]>(`/api/tickets/${ticketId}/runs`),
  listRunEvents: (runId: string, since = 0) =>
    req<(Omit<RunEvent, "payload"> & { payload: any })[]>(
      `/api/runs/${runId}/events?since=${since}`,
    ),
  cancelRun: (runId: string) =>
    req<Run>(`/api/runs/${runId}/cancel`, { method: "POST" }),
  approveRun: (runId: string, note?: string) =>
    req<Run>(`/api/runs/${runId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    }),
  rejectRun: (runId: string, note?: string) =>
    req<Run>(`/api/runs/${runId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    }),
  deleteRun: (runId: string) =>
    req<void>(`/api/runs/${runId}`, { method: "DELETE" }),
  setRunVerdict: (runId: string, verdict: RunUserVerdict | null, note?: string) =>
    req<Run>(`/api/runs/${runId}/verdict`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict, note: note ?? null }),
    }),
  listAgents: (projectId: string) =>
    req<Agent[]>(`/api/projects/${projectId}/agents`),
  createAgent: (projectId: string, input: CreateAgentInput) =>
    req<Agent>(`/api/projects/${projectId}/agents`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAgent: (projectId: string, agentId: string, input: Partial<CreateAgentInput>) =>
    req<Agent>(`/api/projects/${projectId}/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAgent: (projectId: string, agentId: string) =>
    req<void>(`/api/projects/${projectId}/agents/${agentId}`, { method: "DELETE" }),
  listAgentTemplates: () =>
    req<AgentTemplate[]>(`/api/agent-templates`),
  getAgentTemplate: (key: string) =>
    req<AgentTemplate>(`/api/agent-templates/${key}`),
  saveAgentTemplate: (key: string, tpl: AgentTemplate) =>
    req<AgentTemplate>(`/api/agent-templates/${key}`, {
      method: "PUT",
      body: JSON.stringify(tpl),
    }),
  resetAgentTemplate: (key: string) =>
    req<void>(`/api/agent-templates/${key}`, { method: "DELETE" }),
  addAgentFromTemplate: (projectId: string, key: string) =>
    req<Agent>(`/api/projects/${projectId}/agents/from-template/${key}`, {
      method: "POST",
    }),
  getAgentMemory: (projectId: string, agentId: string) =>
    req<{ content: string }>(`/api/projects/${projectId}/agents/${agentId}/memory`),
  putAgentMemory: (projectId: string, agentId: string, content: string) =>
    req<{ content: string }>(`/api/projects/${projectId}/agents/${agentId}/memory`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  getWorkflow: (projectId: string) =>
    req<WorkflowDefinition>(`/api/projects/${projectId}/workflow`),
  putWorkflow: (projectId: string, wf: WorkflowDefinition) =>
    req<WorkflowDefinition>(`/api/projects/${projectId}/workflow`, {
      method: "PUT",
      body: JSON.stringify(wf),
    }),
  resetWorkflow: (projectId: string) =>
    req<WorkflowDefinition>(`/api/projects/${projectId}/workflow/reset`, {
      method: "POST",
    }),

  listWorkflowPresets: () =>
    req<WorkflowPreset[]>(`/api/workflow-templates`),
  deleteWorkflowPreset: (key: string) =>
    req<void>(`/api/workflow-templates/${key}`, { method: "DELETE" }),
  saveProjectAsTemplate: (
    projectId: string,
    body: { key: string; name: string; description?: string },
  ) =>
    req<WorkflowPreset>(`/api/projects/${projectId}/save-as-template`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  applyWorkflowPreset: (projectId: string, key: string) =>
    req<ApplyTemplateResult>(
      `/api/projects/${projectId}/apply-template/${key}`,
      { method: "POST" },
    ),
  importWorkflowPreset: (preset: WorkflowPreset) =>
    req<WorkflowPreset>(`/api/admin/templates/import`, {
      method: "POST",
      body: JSON.stringify(preset),
    }),

  adminMetrics: (days = 7) =>
    req<{
      window_days: number;
      run_counts: Record<string, number>;
      failure_rate_pct: number;
      total_cost_usd: number;
      daily_series: Array<{ date: string; succeeded: number; failed: number; cost: number }>;
      top_failing_phases: Array<{ phase_id: string; fails: number }>;
      longest_phases: Array<{ phase_id: string; avg_duration_ms: number; samples: number }>;
      subagent_stats: Array<{
        subagent: string;
        dispatched: number;
        ok_count: number;
        fail_count: number;
        avg_cost_usd: number;
      }>;
      verdict_stats: { good: number; bad: number; broken_in_prod: number; unrated: number };
    }>(`/api/admin/metrics?days=${days}`),

  adminOverview: () =>
    req<{
      projects_count: number;
      agents_count: number;
      tickets_by_status: Record<string, number>;
      runs_by_status: Record<string, number>;
      runs_total: number;
      total_cost_usd: number;
      cost_by_project: Array<{
        project_id: string;
        project_name: string;
        total_cost_usd: number;
        today_cost_usd: number;
        daily_cost_cap_usd: number | null;
        runs: number;
      }>;
      cost_last_7_days: Array<{ date: string; cost: number; runs: number }>;
    }>(`/api/admin/overview`),
  mkdirFolder: (parent: string, name: string) =>
    req<{ path: string }>(`/api/admin/mkdir`, {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    }),

  browseFolder: (path?: string) =>
    req<{
      path: string;
      parent: string | null;
      is_git: boolean;
      entries: Array<{ name: string; is_dir: boolean; is_git: boolean; is_hidden: boolean }>;
    }>(`/api/admin/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  adminRecentRuns: (limit = 50) =>
    req<Array<{
      run_id: string;
      status: string;
      agent_role: string;
      current_agent_name: string | null;
      total_cost_usd: number | null;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
      project_id: string;
      project_name: string;
      ticket_id: string;
      ticket_key: string | null;
      ticket_title: string;
    }>>(`/api/admin/recent-runs?limit=${limit}`),

  getMemory: (projectId: string) =>
    req<{ content: string }>(`/api/projects/${projectId}/memory`),
  putMemory: (projectId: string, content: string) =>
    req<{ content: string }>(`/api/projects/${projectId}/memory`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  extractTicketsFromSpec: (projectId: string, spec: string) =>
    req<{ markdown: string }>(`/api/projects/${projectId}/tickets/extract-from-spec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    }),
  bulkImport: (projectId: string, input: BulkImportInput) =>
    req<BulkImportResult>(`/api/projects/${projectId}/tickets/bulk`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getScheduler: () => req<SchedulerStatus>(`/api/scheduler`),
  setSchedulerMode: (mode: SchedulerMode) =>
    req<SchedulerStatus>(`/api/scheduler/mode`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  setSchedulerCapacity: (value: number) =>
    req<SchedulerStatus>(`/api/scheduler/max-concurrent`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),

  openPr: (runId: string) =>
    req<{
      repo_name: string;
      pushed: boolean;
      push_output: string;
      pr_url: string | null;
      pr_method: "gh" | "compare-link" | "skipped";
      error?: string;
    }[]>(`/api/runs/${runId}/pr`, { method: "POST" }),

  // ---- Scheduled jobs ------------------------------------------------------

  listJobs: (filter: { project_id?: string | null } = {}) => {
    const q = filter.project_id === undefined ? "" :
      filter.project_id === null ? "?project_id=null" :
      `?project_id=${encodeURIComponent(filter.project_id)}`;
    return req<ScheduledJob[]>(`/api/jobs${q}`);
  },
  getJob: (id: string) => req<ScheduledJob>(`/api/jobs/${id}`),
  createJob: (input: CreateScheduledJobInput) =>
    req<ScheduledJob>("/api/jobs", { method: "POST", body: JSON.stringify(input) }),
  updateJob: (id: string, patch: UpdateScheduledJobInput) =>
    req<ScheduledJob>(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteJob: (id: string) => req<void>(`/api/jobs/${id}`, { method: "DELETE" }),
  runJobNow: (id: string) =>
    req<{ ok: boolean; result: string }>(`/api/jobs/${id}/run-now`, { method: "POST" }),
  previewSchedule: (schedule: string) =>
    req<{ ok: boolean; next_run_at: string | null; error?: string }>("/api/jobs/preview", {
      method: "POST",
      body: JSON.stringify({ schedule }),
    }),

  // Persistent job execution log.
  listJobRuns: (filter: { project_id?: string | null; job_id?: string; since?: string; ok?: boolean; notable?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (filter.project_id === null) q.set("project_id", "null");
    else if (filter.project_id) q.set("project_id", filter.project_id);
    if (filter.job_id) q.set("job_id", filter.job_id);
    if (filter.since) q.set("since", filter.since);
    if (filter.ok !== undefined) q.set("ok", String(filter.ok));
    if (filter.notable) q.set("notable", "true");
    if (filter.limit) q.set("limit", String(filter.limit));
    const qs = q.toString();
    return req<JobRun[]>(`/api/job-runs${qs ? `?${qs}` : ""}`);
  },
  getJobRun: (id: number) => req<JobRun>(`/api/job-runs/${id}`),
  unreadJobRunsCount: (since: string, projectId?: string | null) => {
    const q = new URLSearchParams({ since });
    if (projectId === null) q.set("project_id", "null");
    else if (projectId) q.set("project_id", projectId);
    return req<{ count: number }>(`/api/job-runs/unread-count?${q.toString()}`);
  },
};

/** Open an SSE connection to a run's event stream. */
export function streamRunEvents(
  runId: string,
  onEvent: (ev: any) => void,
  since = 0,
): () => void {
  const es = new EventSource(`/api/runs/${runId}/stream?since=${since}`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch (err) {
      console.error("bad SSE payload", err);
    }
  };
  es.onerror = () => {
    // Browser auto-reconnects; let it.
  };
  return () => es.close();
}
