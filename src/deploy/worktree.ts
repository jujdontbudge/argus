/**
 * Worktree creation (SPEC §7.3.2), in production for the first time.
 *
 * Until #55 the only `git worktree add` in the tree was the test harness's
 * (`src/harness/index.ts:281-295`), which is the whole reason §7.3 was
 * test-only. SPEC §7.3.3 states the why: "worktrees exist because parallel
 * agents in one working tree race the index."
 *
 * Worktrees live in a SIBLING directory (`<repo>-worktrees/`), never under
 * `.argus/`. §13.10's blast-radius test wipes `.argus/` wholesale; a worker's
 * uncommitted work must not be inside the thing Argus is allowed to delete.
 */
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface GitRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** The one place worktree code shells out; injected so the seam is testable. */
export type GitRun = (
  args: readonly string[],
  cwd: string,
) => Promise<GitRunResult>;

export const runGit: GitRun = async (args, cwd) => {
  const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

export type DependencyRun = (
  cwd: string,
) => Promise<{ exitCode: number; stderr: string; stdout: string }>;

/** Materialise the lockfile's graph inside the checkout the worker will use. */
export const installWorktreeDependencies: DependencyRun = async (cwd) => {
  try {
    const child = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
  } catch (error) {
    return { exitCode: 127, stderr: message(error), stdout: "" };
  }
};

/** `argus/ticket-55` — one branch per ticket, namespaced so it is obvious. */
export function branchForTicket(ticket: string): string {
  return `argus/ticket-${slug(ticket)}`;
}

/** `<parent>/<repo>-worktrees/ticket-55`. */
export function worktreeForTicket(repo: string, ticket: string): string {
  const root = resolve(repo);
  return join(dirname(root), `${basename(root)}-worktrees`, `ticket-${slug(ticket)}`);
}

function slug(ticket: string): string {
  const cleaned = ticket.replace(/^#/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned === "" ? "unnamed" : cleaned;
}

export interface WorktreeRequest {
  base?: string;
  branch: string;
  path: string;
  repo: string;
}

export type WorktreeResult =
  | { status: "created"; path: string; branch: string }
  | { status: "failed"; reason: string };

export async function createWorktree(
  request: WorktreeRequest,
  git: GitRun = runGit,
  install: DependencyRun = installWorktreeDependencies,
): Promise<WorktreeResult> {
  try {
    await mkdir(dirname(request.path), { recursive: true });
  } catch (error) {
    return {
      reason: `cannot create the worktree parent directory: ${message(error)}`,
      status: "failed",
    };
  }
  const args = [
    "worktree",
    "add",
    "--quiet",
    "-b",
    request.branch,
    request.path,
    ...(request.base === undefined ? [] : [request.base]),
  ];
  const result = await git(args, request.repo);
  if (result.exitCode !== 0) {
    return {
      reason:
        result.stderr.trim() ||
        `git worktree add exited ${result.exitCode}`,
      status: "failed",
    };
  }

  if (await isFile(join(request.path, "package.json"))) {
    const installed = await install(request.path);
    if (installed.exitCode !== 0) {
      // A failed provision must be retryable. Both names were created by the
      // successful `git worktree add -b` immediately above, so they are the
      // exact resources this call owns.
      await git(["worktree", "remove", "--force", request.path], request.repo);
      await git(["branch", "--delete", "--force", request.branch], request.repo);
      const detail = installed.stderr.trim() || installed.stdout.trim();
      return {
        reason: [
          `cannot install worktree dependencies: bun install --frozen-lockfile exited ${installed.exitCode}`,
          detail,
        ]
          .filter((part) => part !== "")
          .join(": "),
        status: "failed",
      };
    }
  }
  return { branch: request.branch, path: request.path, status: "created" };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
