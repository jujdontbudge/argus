import { realpath } from "node:fs/promises";

/**
 * The Retro eye's git signal (SPEC §5.5): git is ground truth for "work
 * happened". This module only OBSERVES — it enumerates commits made since the
 * eye's cursor plus the current working-tree delta, and never writes to the
 * repo it watches.
 *
 * Worktrees are first-class: §7.3 dispatches every ticket into its own git
 * worktree, so the scan covers the main checkout AND every linked worktree,
 * and every root reports the PARENT repo it belongs to — the repo that owns
 * `.argus/` and the tracker the retro is filed against.
 */

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner; the default runs the real git CLI. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>;

/** The real git CLI; shared with the curator's backup module (#35). */
export const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

export interface GitCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  ts: string;
  subject: string;
  body: string;
  files: string[];
  diff: string;
}

/** The uncommitted delta of one working tree (tracked + untracked). */
export interface WorkingTreeChange {
  files: string[];
  diff: string;
}

/** One scanned checkout: the main repo or one of its linked worktrees. */
export interface RootScan {
  /** Absolute path of the checkout the changes were made in. */
  dir: string;
  commits: GitCommit[];
  workingTree: WorkingTreeChange | null;
}

export interface GitScan {
  /** The parent repo — owner of `.argus/` and of the tracker (§7.3 worktrees). */
  repoRoot: string;
  roots: RootScan[];
  /** The cursor to persist: commit shas that have now been reported. */
  seen: string[];
}

export interface ScanGitOptions {
  /** Any directory inside the repo (or one of its worktrees). */
  repo: string;
  /** Commit shas already reported by an earlier scan. */
  seen?: Iterable<string>;
  /** Walk bound per root — a retro reports recent work, not repo history. */
  maxCommits?: number;
  /** Diffs are evidence for a ticket body, not an archive; truncate loudly. */
  maxDiffBytes?: number;
  /** Cursor bound: the newest N shas are remembered across scans. */
  maxSeen?: number;
  run?: GitRunner;
}

const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_MAX_DIFF_BYTES = 60_000;
const DEFAULT_MAX_SEEN = 1_000;

/**
 * Field separator for `git show --format`. git expands `%x1f` itself, so the
 * ASCII unit separator never rides in argv — a raw control byte there would be
 * truncated at the C-string boundary and silently shorten the format.
 */
const FIELD_FORMAT = "%x1f";
const FIELD = "\u001f";

/**
 * Argus' own state is not work. `.argus/` holds the eyes' cursors, digests
 * and registry — all of it changing constantly and none of it a retro — so
 * the scan is blind to it whether or not the repo remembered to gitignore it.
 */
const ARGUS_DIR = ".argus";

function isArgusState(path: string): boolean {
  return path === ARGUS_DIR || path.startsWith(`${ARGUS_DIR}/`);
}

function truncate(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;
  return `${diff.slice(0, limit)}\n… diff truncated at ${limit} bytes …\n`;
}

async function readCommit(
  run: GitRunner,
  dir: string,
  sha: string,
  maxDiffBytes: number,
): Promise<GitCommit | null> {
  const format = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join(FIELD_FORMAT);
  const header = await run(["show", "-s", `--format=${format}`, sha], dir);
  if (header.exitCode !== 0) return null;
  const [, authorName = "", authorEmail = "", ts = "", subject = "", body = ""] =
    header.stdout.split(FIELD);
  const names = await run(["show", "--format=", "--name-only", sha], dir);
  const diff = await run(["show", "--format=", "--patch", sha], dir);
  return {
    sha,
    authorName,
    authorEmail,
    ts,
    subject,
    body: body.trimEnd(),
    files: names.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0 && !isArgusState(line)),
    diff: truncate(diff.stdout, maxDiffBytes),
  };
}

/**
 * Commits reachable from a root's HEAD that the cursor has not seen, oldest
 * first. The walk stops at the first seen sha: the cursor is a boundary, so a
 * long history is never re-read.
 */
async function commitsSince(
  run: GitRunner,
  dir: string,
  seen: ReadonlySet<string>,
  maxCommits: number,
  maxDiffBytes: number,
): Promise<GitCommit[]> {
  const listed = await run(
    ["log", "--format=%H", `--max-count=${maxCommits}`, "HEAD"],
    dir,
  );
  if (listed.exitCode !== 0) return []; // unborn HEAD: nothing committed yet
  const fresh: string[] = [];
  for (const sha of listed.stdout.split("\n").map((line) => line.trim())) {
    if (sha.length === 0) continue;
    if (seen.has(sha)) break;
    fresh.push(sha);
  }
  const commits: GitCommit[] = [];
  for (const sha of fresh.reverse()) {
    const commit = await readCommit(run, dir, sha, maxDiffBytes);
    if (commit) commits.push(commit);
  }
  return commits;
}

/**
 * The uncommitted delta of one checkout. Untracked files are included — a
 * rogue session's brand-new file is exactly the work a retro must record —
 * and they are diffed through `--no-index` so the eye never stages anything
 * in the repo it watches.
 */
async function workingTreeOf(
  run: GitRunner,
  dir: string,
  maxDiffBytes: number,
): Promise<WorkingTreeChange | null> {
  const status = await run(["status", "--porcelain", "--untracked-files=all"], dir);
  if (status.exitCode !== 0) return null;
  const files: string[] = [];
  const untracked: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 2);
    // Renames read `R  old -> new`; the new path is what the diff shows.
    const path = line.slice(3).split(" -> ").at(-1)!.replace(/^"|"$/g, "");
    if (isArgusState(path)) continue;
    files.push(path);
    if (code === "??") untracked.push(path);
  }
  if (files.length === 0) return null;

  const tracked = await run(["diff", "HEAD", "--", ".", `:(exclude)${ARGUS_DIR}`], dir);
  const parts = tracked.exitCode === 0 ? [tracked.stdout] : [];
  for (const path of untracked) {
    // `--no-index` exits 1 when the files differ: that IS the success case.
    const patch = await run(["diff", "--no-index", "--", "/dev/null", path], dir);
    if (patch.stdout.length > 0) parts.push(patch.stdout);
  }
  return {
    files,
    diff: truncate(parts.join("").trimEnd(), maxDiffBytes),
  };
}

/**
 * Symlinked directories (macOS temp dirs are `/var` → `/private/var`) must
 * compare equal: git reports resolved paths, so everything joined against a
 * checkout — registry workspaces, observed session cwds — is resolved too.
 */
export async function resolvePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Every checkout sharing this repo's object store, main worktree FIRST. A
 * commit made in `~/argus-worktrees/<slug>` belongs to the parent repo — that
 * is where `.argus/`, the registry and the tracker live (§7.3), so the parent
 * is what the scan reports as `repoRoot`.
 */
async function listRoots(
  run: GitRunner,
  from: string,
): Promise<{ repoRoot: string; dirs: string[] } | null> {
  const listed = await run(["worktree", "list", "--porcelain"], from);
  if (listed.exitCode === 0) {
    const dirs: string[] = [];
    for (const line of listed.stdout.split("\n")) {
      const match = line.match(/^worktree (.+)$/);
      if (match) dirs.push(await resolvePath(match[1]!));
    }
    if (dirs.length > 0) return { repoRoot: dirs[0]!, dirs };
  }
  // No worktree support (or a bare/odd layout): the checkout is its own root.
  const toplevel = await run(["rev-parse", "--show-toplevel"], from);
  if (toplevel.exitCode !== 0) return null;
  const dir = await resolvePath(toplevel.stdout.trim());
  return { repoRoot: dir, dirs: [dir] };
}

export async function scanGit(options: ScanGitOptions): Promise<GitScan> {
  const run = options.run ?? defaultGitRunner;
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const maxSeen = options.maxSeen ?? DEFAULT_MAX_SEEN;
  const seen = new Set(options.seen ?? []);

  const found = await listRoots(run, options.repo);
  if (!found) {
    return { repoRoot: options.repo, roots: [], seen: [...seen].slice(0, maxSeen) };
  }

  const roots: RootScan[] = [];
  const reported: string[] = [];
  for (const dir of found.dirs) {
    const commits = await commitsSince(run, dir, seen, maxCommits, maxDiffBytes);
    // Within one scan every root sees the same cursor, but a sha reported by
    // one root must not be reported again by another sharing the ref.
    for (const commit of commits) seen.add(commit.sha);
    reported.push(...commits.map((commit) => commit.sha).reverse());
    roots.push({
      dir,
      commits,
      workingTree: await workingTreeOf(run, dir, maxDiffBytes),
    });
  }
  const carried = [...seen].filter((sha) => !reported.includes(sha));
  return {
    repoRoot: found.repoRoot,
    roots,
    seen: [...reported, ...carried].slice(0, maxSeen),
  };
}
