import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** True for git URLs (https://, git@, ssh://, git://). False for local paths. */
export function looksLikeGitUrl(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(s);
}

/** Init a fresh git repo at `dir` if it isn't one already. Idempotent. */
export async function ensureGitRepo(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    throw new Error(`path does not exist: ${dir}`);
  }
  if (fs.existsSync(path.join(dir, ".git"))) return;
  const init = await new Promise<{ code: number; err: string }>((resolve, reject) => {
    const c = spawn("git", ["init"], { cwd: dir, stdio: "pipe" });
    let err = "";
    c.stderr.on("data", (b) => (err += b.toString()));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code: code ?? -1, err }));
  });
  if (init.code !== 0) throw new Error(`git init failed: ${init.err}`);
  // Need at least one commit before worktree add works. Create an empty initial commit.
  const initial = await new Promise<{ code: number; err: string }>((resolve, reject) => {
    const c = spawn("git", ["commit", "--allow-empty", "-m", "initial commit"], {
      cwd: dir, stdio: "pipe",
    });
    let err = "";
    c.stderr.on("data", (b) => (err += b.toString()));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code: code ?? -1, err }));
  });
  if (initial.code !== 0) {
    // Could fail if no user.email — don't block; user will hit a clearer error on first run.
  }
}

export function gitClone(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      // Already cloned — treat as success.
      return resolve();
    }
    const child = spawn("git", ["clone", url, dest], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (${code}): ${stderr}`));
    });
  });
}

function gitRun(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Create (or reuse) a git worktree at `worktreePath` on a fresh branch
 * `branchName` based on the repo's default branch.
 *
 * - If the worktree dir already exists, we trust it.
 * - Otherwise we create the branch first (from origin/<default>) and add the worktree.
 */
/** Pick the base ref for worktree branching / diffing.
 *  Prefer `origin/<branch>` (cloned/pushed repos). Fall back to local `<branch>`
 *  when there is no `origin` remote — typical for "init locally, push later" flows. */
async function resolveBaseRef(repoPath: string, baseBranch: string): Promise<string> {
  const origin = await gitRun(["rev-parse", "--verify", `origin/${baseBranch}`], repoPath);
  if (origin.code === 0) return `origin/${baseBranch}`;
  const local = await gitRun(["rev-parse", "--verify", baseBranch], repoPath);
  if (local.code === 0) return baseBranch;
  throw new Error(`base branch "${baseBranch}" not found locally or as origin/${baseBranch} in ${repoPath}`);
}

export async function ensureWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  if (fs.existsSync(worktreePath)) return;

  // Best-effort fetch: only meaningful if origin exists. Don't fail when it doesn't.
  await gitRun(["fetch", "origin", baseBranch], repoPath);

  const baseRef = await resolveBaseRef(repoPath, baseBranch);

  // Create branch off baseRef if it does not exist yet.
  const branchCheck = await gitRun(["rev-parse", "--verify", branchName], repoPath);
  if (branchCheck.code !== 0) {
    const create = await gitRun(["branch", branchName, baseRef], repoPath);
    if (create.code !== 0) {
      throw new Error(`failed to create branch ${branchName}: ${create.stderr}`);
    }
  }

  fs.mkdirSync(worktreePath, { recursive: true });
  // Remove the empty dir we just made — git worktree add wants the path to NOT exist.
  fs.rmdirSync(worktreePath);

  const add = await gitRun(["worktree", "add", worktreePath, branchName], repoPath);
  if (add.code !== 0) {
    throw new Error(`worktree add failed: ${add.stderr}`);
  }
}

export async function diffWorktree(worktreePath: string, baseBranch: string): Promise<string> {
  // Mirror the same fallback so diffs work in local-only repos.
  const baseRef = await resolveBaseRef(worktreePath, baseBranch);
  const res = await gitRun(["diff", baseRef], worktreePath);
  return res.stdout;
}

/**
 * Remove a worktree and (optionally) delete its branch from the parent repo.
 * Idempotent — missing worktree or branch are silently ignored.
 */
export async function removeWorktree(
  parentRepoPath: string,
  worktreePath: string,
  branchName: string | null,
): Promise<void> {
  if (fs.existsSync(parentRepoPath)) {
    if (fs.existsSync(worktreePath)) {
      const r = await gitRun(["worktree", "remove", "--force", worktreePath], parentRepoPath);
      // Even if git fails (e.g. worktree was deleted manually), fall through to
      // a manual rm so we don't leak disk.
      if (r.code !== 0) {
        try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
      // Prune stale worktree records.
      await gitRun(["worktree", "prune"], parentRepoPath);
    }
    if (branchName) {
      await gitRun(["branch", "-D", branchName], parentRepoPath);
    }
  } else if (fs.existsSync(worktreePath)) {
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }
}

/** Try to fast-forward the parent repo's `baseBranch` to the worktree's HEAD.
 *  - Skips if parent repo has uncommitted/staged changes (won't surprise the user).
 *  - Skips if HEAD of parent is on a different branch than baseBranch and switching would lose state.
 *  - Skips if the merge isn't ff-only (history diverged).
 *  Returns a structured result so the engine can emit a clear system event. */
export async function tryFastForwardParent(
  worktreePath: string,
  parentRepoPath: string,
  baseBranch: string,
): Promise<{ merged: boolean; reason: string; sha?: string }> {
  if (!fs.existsSync(parentRepoPath)) {
    return { merged: false, reason: "parent repo path does not exist" };
  }

  // 1. Get the worktree's HEAD SHA — that's what we want to bring in.
  const headRes = await gitRun(["rev-parse", "HEAD"], worktreePath);
  if (headRes.code !== 0) {
    return { merged: false, reason: `cannot read worktree HEAD: ${headRes.stderr.trim()}` };
  }
  const sha = headRes.stdout.trim();

  // Same SHA already? Nothing to do.
  const parentHead = await gitRun(["rev-parse", baseBranch], parentRepoPath);
  if (parentHead.code === 0 && parentHead.stdout.trim() === sha) {
    return { merged: false, reason: "no new commits", sha };
  }

  // 2. Refuse if parent repo has uncommitted/staged work — never overwrite user state.
  const status = await gitRun(["status", "--porcelain"], parentRepoPath);
  if (status.code !== 0) {
    return { merged: false, reason: `git status failed: ${status.stderr.trim()}` };
  }
  if (status.stdout.trim() !== "") {
    return { merged: false, reason: "parent repo has uncommitted changes (run `git status` to review)" };
  }

  // 3. Make sure parent is currently on baseBranch (or can switch to it cleanly).
  const branch = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], parentRepoPath);
  const currentBranch = branch.stdout.trim();
  if (currentBranch !== baseBranch) {
    const checkout = await gitRun(["checkout", baseBranch], parentRepoPath);
    if (checkout.code !== 0) {
      return { merged: false, reason: `cannot switch parent to ${baseBranch}: ${checkout.stderr.trim()}` };
    }
  }

  // 4. Fetch the worktree's HEAD into the parent.
  const fetch = await gitRun(["fetch", worktreePath, "HEAD"], parentRepoPath);
  if (fetch.code !== 0) {
    return { merged: false, reason: `fetch failed: ${fetch.stderr.trim()}` };
  }

  // 5. Fast-forward only — refuse to merge if the histories diverged.
  const merge = await gitRun(["merge", "--ff-only", "FETCH_HEAD"], parentRepoPath);
  if (merge.code !== 0) {
    return { merged: false, reason: `not fast-forward (history diverged): ${merge.stderr.trim()}` };
  }

  return { merged: true, reason: "fast-forwarded", sha };
}

export async function pushBranch(
  worktreePath: string,
  branchName: string,
): Promise<{ ok: boolean; output: string }> {
  const r = await gitRun(["push", "-u", "origin", branchName], worktreePath);
  return { ok: r.code === 0, output: r.stderr + r.stdout };
}

export async function getRemoteUrl(worktreePath: string): Promise<string | null> {
  const r = await gitRun(["remote", "get-url", "origin"], worktreePath);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function detectDefaultBranch(repoPath: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      { cwd: repoPath },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("close", () => {
      const trimmed = out.trim();
      // origin/main → main
      const branch = trimmed.split("/").pop() || "main";
      resolve(branch);
    });
    child.on("error", () => resolve("main"));
  });
}
