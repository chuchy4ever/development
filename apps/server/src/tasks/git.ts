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

      // Skip repos that this run didn't touch — the ticket may only modify a
      // subset of project repos (e.g. plant-api-only ticket in a 2-repo
      // project). No worktree branch exists, nothing to push; treat as no-op
      // success so the gate doesn't fail on uninvolved repos.
      const branchProbe = await gitRun(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/ceo/"],
        repo.local_path,
        controller.signal,
      );
      const branchExists = branchProbe.code === 0
        && branchProbe.stdout.split("\n").map((s) => s.trim()).some((b) => b.endsWith(`-${ctx.runId}`));
      if (!branchExists) {
        results.push({ ok: true, preview, status: 0, body: `no worktree branch for this run in ${repo.name} — skipped (ticket didn't touch this repo)` });
        continue;
      }

      ctx.emit("command_start", { phase_id: ctx.phase.id, command: `git push → ${preview}` });

      let pushResult: { code: number; stdout: string; stderr: string };
      if (strategy === "squash") {
        // Merge-base + squash + commit + push. Idempotent w.r.t. whether the
        // engine's auto-merge already happened (we reset to merge-base anyway).
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
        // ff_only: merge worktree branch into base_branch then push. Doing the
        // merge here (not relying on the engine's auto-merge) means git_push
        // can run as a gate mid-Director-loop, before mark_done — and Director
        // sees the push verdict on the next turn. Idempotent: if base already
        // contains the worktree HEAD (engine already auto-merged), the merge
        // step is a no-op and we just push.
        pushResult = await ffMergeAndPush({
          parentPath: repo.local_path,
          baseBranch: repo.default_branch,
          runId: ctx.runId,
          remote,
          signal: controller.signal,
        });
      }

      // Transient push retry: GitLab/GitHub occasionally returns 429, network
      // blips. Retry up to 2× before declaring failure so Director doesn't
      // give_up on a 30s outage.
      let attempt = 0;
      while (!cancelled && pushResult.code !== 0 && attempt < 2 && isTransientPushError(pushResult.stderr + pushResult.stdout)) {
        attempt++;
        const waitMs = 2000 * attempt;
        ctx.emit("command_output", { phase_id: ctx.phase.id, chunk: `transient push failure, retrying in ${waitMs}ms (${attempt}/2)\n` });
        await new Promise((r) => setTimeout(r, waitMs));
        if (strategy === "squash") {
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
          pushResult = await ffMergeAndPush({
            parentPath: repo.local_path,
            baseBranch: repo.default_branch,
            runId: ctx.runId,
            remote,
            signal: controller.signal,
          });
        }
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

/** Conservative transient classifier — false positives just cost one retry,
 *  false negatives mean Director gives up on something recoverable. */
function isTransientPushError(output: string): boolean {
  const s = output.toLowerCase();
  return /429|too many requests|rate.?limit/.test(s)
    || /timeout|timed out|etimedout/.test(s)
    || /could not resolve host|name resolution|enotfound/.test(s)
    || /connection (reset|refused|closed)|econnreset|econnrefused/.test(s)
    || /service unavailable|503|502|bad gateway/.test(s);
}

interface FfMergeArgs {
  parentPath: string;
  baseBranch: string;
  runId: string;
  remote: string;
  signal: AbortSignal;
}

/** ff-only merge the run's worktree branch into base_branch, then push.
 *  Idempotent — if base already contains worktree HEAD (engine auto-merge
 *  already ran), the merge is "Already up to date" and push proceeds. */
async function ffMergeAndPush(args: FfMergeArgs): Promise<{ code: number; stdout: string; stderr: string }> {
  // Resolve the run's worktree branch by suffix match.
  const list = await gitRun(["for-each-ref", "--format=%(refname:short)", "refs/heads/ceo/"], args.parentPath, args.signal);
  if (list.code !== 0) return list;
  const branchRef = list.stdout.split("\n").map((s) => s.trim()).find((b) => b.endsWith(`-${args.runId}`));
  if (!branchRef) {
    return { code: 1, stdout: "", stderr: `git_push: no ceo branch ending in -${args.runId} in ${args.parentPath}` };
  }

  // Refuse if dirty — never overwrite user state.
  const status = await gitRun(["status", "--porcelain"], args.parentPath, args.signal);
  if (status.code !== 0) return status;
  if (status.stdout.trim()) {
    return { code: 1, stdout: "", stderr: `git_push: parent ${args.parentPath} has uncommitted changes — refusing merge` };
  }
  const head = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], args.parentPath, args.signal);
  if (head.stdout.trim() !== args.baseBranch) {
    const co = await gitRun(["checkout", args.baseBranch], args.parentPath, args.signal);
    if (co.code !== 0) return co;
  }

  // Align local base with origin first (parallel runs may have already pushed).
  const fetch = await gitRun(["fetch", args.remote, args.baseBranch], args.parentPath, args.signal);
  if (fetch.code !== 0) return fetch;
  const remoteRef = `${args.remote}/${args.baseBranch}`;
  const reset = await gitRun(["reset", "--hard", remoteRef], args.parentPath, args.signal);
  if (reset.code !== 0) return reset;

  // If worktree branch is already in origin, nothing to do.
  const ancestorCheck = await gitRun(["merge-base", "--is-ancestor", branchRef, remoteRef], args.parentPath, args.signal);
  if (ancestorCheck.code === 0) {
    return { code: 0, stdout: `worktree branch ${branchRef} already merged into ${remoteRef} — nothing to push`, stderr: "" };
  }

  // ff-only merge worktree branch in. Fails if worktree branched from an
  // older base than origin's current tip (history diverged). The squash
  // strategy handles that case; ff_only mode insists on a clean linear
  // history, which is the trade-off.
  const merge = await gitRun(["merge", "--ff-only", branchRef], args.parentPath, args.signal);
  if (merge.code !== 0) return merge;

  // Push.
  return gitRun(["push", args.remote, args.baseBranch], args.parentPath, args.signal);
}

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

  // 1. Refuse if parent repo has uncommitted/staged work — never overwrite user state.
  const status = await gitRun(["status", "--porcelain"], args.parentPath, args.signal);
  if (status.code !== 0) return status;
  if (status.stdout.trim()) {
    return { code: 1, stdout: "", stderr: `squash: parent ${args.parentPath} has uncommitted changes — refusing` };
  }

  // 2. Make sure we're on baseBranch.
  const headBranch = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], args.parentPath, args.signal);
  if (headBranch.stdout.trim() !== args.baseBranch) {
    const co = await gitRun(["checkout", args.baseBranch], args.parentPath, args.signal);
    if (co.code !== 0) return co;
  }

  // 3. Fetch + align local base with origin tip BEFORE we squash anything.
  //    Critical: another run (parallel or earlier-finished) may have already
  //    pushed work after this run started. Reset-to-merge-base (old behavior)
  //    would lose those commits and the subsequent push would be rejected
  //    non-ff. By matching origin first, the squash builds on top of the
  //    latest state and the push always fast-forwards.
  const fetch = await gitRun(["fetch", args.remote, args.baseBranch], args.parentPath, args.signal);
  if (fetch.code !== 0) return fetch;
  const remoteRef = `${args.remote}/${args.baseBranch}`;
  const reset = await gitRun(["reset", "--hard", remoteRef], args.parentPath, args.signal);
  if (reset.code !== 0) return reset;

  // 4. If the worktree branch's HEAD is already an ancestor of origin's tip,
  //    everything in the worktree is already merged remotely (e.g. an earlier
  //    sibling run squash-merged it). Nothing to do — no-op success.
  const ancestorCheck = await gitRun(["merge-base", "--is-ancestor", branchRef, remoteRef], args.parentPath, args.signal);
  if (ancestorCheck.code === 0) {
    return { code: 0, stdout: `worktree branch ${branchRef} already merged into ${remoteRef} — nothing to push`, stderr: "" };
  }

  // 5. Squash-merge the worktree branch on top of (now-current) base.
  const sq = await gitRun(["merge", "--squash", branchRef], args.parentPath, args.signal);
  if (sq.code !== 0) return sq;
  // If diff is empty post-squash, every file change on the worktree branch
  // is already present in origin (e.g. via a different path / earlier run).
  // Treat as no-op success.
  const diff = await gitRun(["diff", "--cached", "--quiet"], args.parentPath, args.signal);
  if (diff.code === 0) {
    return { code: 0, stdout: "squash produced no changes (worktree diff already in remote)", stderr: "" };
  }
  const commit = await gitRun(["commit", "-m", args.commitMessage], args.parentPath, args.signal);
  if (commit.code !== 0) return commit;

  // 6. Push. Should always fast-forward now because step 3 aligned with origin
  //    and step 5 only added a single new commit on top.
  return gitRun(["push", args.remote, args.baseBranch], args.parentPath, args.signal);
}
