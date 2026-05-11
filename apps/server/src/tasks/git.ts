/**
 * Git push connector — fires after a Director run terminates and pushes each
 * project repo's base branch to its remote. Works with any remote (GitLab,
 * GitHub, Bitbucket, raw ssh) because it's pure `git push` over the user's
 * existing remote config — no GitHub-specific API.
 *
 * Pre-condition: the in-engine auto-merge (tryFastForwardParent) has already
 * brought the run's worktree commits into base_branch. We just push that
 * base_branch ref.
 *
 * Config shape:
 *   {
 *     remote?: string,    // defaults to "origin"
 *     trigger?: "always" | "success" | "failure"   // defaults to "success"
 *   }
 *
 * No per-action array — one phase = one push per repo. Multi-repo projects
 * push each repo's base_branch in sequence.
 */

import { spawn } from "node:child_process";
import type { TaskExecutor, TaskVerdict } from "./types.js";
import {
  type Trigger,
  shouldFire,
  isTrigger,
  buildVars,
  render,
  aggregateResults,
  emptyEligibleVerdict,
  type ActionResult,
} from "./connectorShared.js";

type Strategy = "ff_only" | "squash";

interface GitPushConfig {
  remote?: string;
  trigger?: Trigger;
  /** ff_only (default): push whatever the engine's auto-merge left on base_branch
   *                     (preserves every sub-agent commit verbatim).
   *  squash:           reset base_branch back to merge-base, redo as a single
   *                    squash commit with `commit_message_template`, then push.
   *                    All worktree changes land in ONE commit on base_branch. */
  strategy?: Strategy;
  /** Used when strategy=squash. Supports {ticket_key} {ticket_title}
   *  {project_name} {run_id} {verdict_summary} {verdict_status}. */
  commit_message_template?: string;
}

function gitRun(argv: string[], cwd: string, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", argv, { cwd });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => { stdout += c.toString(); });
    p.stderr.on("data", (c) => { stderr += c.toString(); });
    const onAbort = () => { try { p.kill("SIGTERM"); } catch {} };
    signal.addEventListener("abort", onAbort);
    p.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    p.on("error", () => resolve({ code: -1, stdout, stderr }));
  });
}

export const gitPushExecutor: TaskExecutor = {
  type: "git_push",

  validate(config) {
    const c = config as GitPushConfig;
    if (c.remote !== undefined && (typeof c.remote !== "string" || !c.remote.trim())) {
      return 'git_push: "remote" must be a non-empty string';
    }
    if (c.trigger !== undefined && !isTrigger(c.trigger)) {
      return 'git_push: "trigger" must be "always" | "success" | "failure"';
    }
    if (c.strategy !== undefined && c.strategy !== "ff_only" && c.strategy !== "squash") {
      return 'git_push: "strategy" must be "ff_only" | "squash"';
    }
    if (c.strategy === "squash" && (!c.commit_message_template || !c.commit_message_template.trim())) {
      return 'git_push: squash strategy requires "commit_message_template"';
    }
    return null;
  },

  async run(config, ctx): Promise<TaskVerdict> {
    const c = config as GitPushConfig;
    const trigger: Trigger = c.trigger ?? "success";
    if (!shouldFire(trigger, ctx.lastWasFailure)) {
      return emptyEligibleVerdict("git_push", 1, 1);
    }
    const remote = (c.remote ?? "origin").trim();
    const strategy: Strategy = c.strategy ?? "ff_only";
    const vars = buildVars(ctx);
    const commitMsg = c.commit_message_template ? render(c.commit_message_template, vars) : "";

    const controller = new AbortController();
    let cancelled = false;
    ctx.registerCancel(() => { cancelled = true; controller.abort(); });

    const results: ActionResult[] = [];
    for (const repo of ctx.project.repos) {
      if (cancelled) break;
      const preview = `${remote} ${repo.default_branch} (${repo.name}, ${strategy})`;
      ctx.emit("command_start", { phase_id: ctx.phase.id, command: `git push → ${preview}` });

      let pushResult: { code: number; stdout: string; stderr: string };
      if (strategy === "squash") {
        // Engine's auto-merge already FF'd base_branch to worktree HEAD. Roll
        // that back to the merge-base, redo as a single squash commit with our
        // template, then push. Skip if there are no actual changes (no-op run).
        const squashRes = await squashAndPush({
          parentPath: repo.local_path,
          baseBranch: repo.default_branch,
          runId: ctx.runId,
          remote,
          commitMessage: commitMsg,
          signal: controller.signal,
        });
        pushResult = { code: squashRes.code, stdout: squashRes.stdout, stderr: squashRes.stderr };
      } else {
        // ff_only: just push whatever's on base_branch now.
        pushResult = await gitRun(["push", remote, repo.default_branch], repo.local_path, controller.signal);
      }

      const ok = pushResult.code === 0;
      const body = ok
        ? (pushResult.stderr.trim() || pushResult.stdout.trim() || "up-to-date")
        : `exit ${pushResult.code}: ${(pushResult.stderr || pushResult.stdout).trim().slice(0, 400)}`;
      results.push({ ok, preview, status: pushResult.code, body });
      ctx.emit("command_end", { phase_id: ctx.phase.id, exit_code: pushResult.code, cancelled });
    }
    ctx.unregisterCancel();
    return aggregateResults({ label: "git_push", results, totalConfigured: ctx.project.repos.length });
  },
};

interface SquashArgs {
  parentPath: string;
  baseBranch: string;
  /** Run ID — used to resolve the run's `ceo/<slug>-<runId>` worktree branch
   *  by suffix match in the parent repo's refs. */
  runId: string;
  remote: string;
  commitMessage: string;
  signal: AbortSignal;
}

async function squashAndPush(args: SquashArgs): Promise<{ code: number; stdout: string; stderr: string }> {
  // 0. Resolve the run's worktree branch by suffix (engine names them
  //    `ceo/<slug>-<runId>`, unique per run within a repo).
  const list = await gitRun(["for-each-ref", "--format=%(refname:short)", "refs/heads/ceo/"], args.parentPath, args.signal);
  if (list.code !== 0) return list;
  const branchRef = list.stdout.split("\n").map((s) => s.trim()).find((b) => b.endsWith(`-${args.runId}`));
  if (!branchRef) {
    return { code: 1, stdout: "", stderr: `squash: no ceo branch ending in -${args.runId} in ${args.parentPath}` };
  }

  // 1. Make sure we're on baseBranch in the parent.
  const head = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], args.parentPath, args.signal);
  if (head.stdout.trim() !== args.baseBranch) {
    const co = await gitRun(["checkout", args.baseBranch], args.parentPath, args.signal);
    if (co.code !== 0) return co;
  }

  // 2. Find merge-base of baseBranch and the worktree branch — the point from
  //    which the run's work diverged. Reset baseBranch back there to undo the
  //    engine's FF auto-merge cleanly.
  const mb = await gitRun(["merge-base", "HEAD", branchRef], args.parentPath, args.signal);
  if (mb.code !== 0) return mb;
  const baseSha = mb.stdout.trim();
  if (!baseSha) return { code: 1, stdout: "", stderr: "merge-base returned empty" };

  // 3. If HEAD is already at merge-base (engine didn't actually FF — e.g. no
  //    new commits), nothing to squash; treat as no-op success.
  const headSha = await gitRun(["rev-parse", "HEAD"], args.parentPath, args.signal);
  if (headSha.stdout.trim() === baseSha) {
    return { code: 0, stdout: "no new commits to squash", stderr: "" };
  }

  // 4. Reset to merge-base, squash merge, commit with template.
  const reset = await gitRun(["reset", "--hard", baseSha], args.parentPath, args.signal);
  if (reset.code !== 0) return reset;
  const sq = await gitRun(["merge", "--squash", branchRef], args.parentPath, args.signal);
  if (sq.code !== 0) return sq;
  // Check if anything was actually staged. Squash on an already-merged branch
  // produces no diff → commit would fail with "nothing to commit".
  const diff = await gitRun(["diff", "--cached", "--quiet"], args.parentPath, args.signal);
  if (diff.code === 0) {
    return { code: 0, stdout: "squash produced no changes (already merged)", stderr: "" };
  }
  const commit = await gitRun(["commit", "-m", args.commitMessage], args.parentPath, args.signal);
  if (commit.code !== 0) return commit;

  // 5. Push.
  return gitRun(["push", args.remote, args.baseBranch], args.parentPath, args.signal);
}
