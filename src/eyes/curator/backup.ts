/**
 * The pre-pass backup (SPEC §5.1 via research #16 §8(iii)).
 *
 * Hermes tars the skills tree into `skills/.curator_backups/<utc-iso>/`
 * (`agent/curator_backup.py`). #16's verdict replaces that with "a git commit
 * before the pass" — same rollback guarantee, no snapshot files. There is one
 * wrinkle the note could not know: `.argus/` is a committed .gitignore line in
 * every target repo (SPEC §4), so the target repo's history CANNOT hold the
 * stores, and an eye must never commit the user's working tree anyway.
 *
 * So the snapshot goes into a private git repo of its own —
 * `.argus/curator_backup.git`, work tree `.argus/`, tracking `skills/` and
 * `memory/` and nothing else. It is invisible to the target repo (it lives
 * inside the ignored directory), it never stages a line of the user's work,
 * and `restoreSnapshot` is an ordinary `git checkout` away.
 *
 * Best-effort, exactly like the native layer (`agent/curator.py:1452-1462`):
 * a failed snapshot is reported into the run report and never blocks the pass.
 */
import { join } from "node:path";
import { defaultGitRunner, type GitRunner } from "../retro/git";

const IDENTITY = [
  "-c",
  "user.name=Argus curator",
  "-c",
  "user.email=curator@argus.local",
  "-c",
  "commit.gpgsign=false",
];

export function backupGitDir(repo: string): string {
  return join(repo, ".argus/curator_backup.git");
}

export function backupWorkTree(repo: string): string {
  return join(repo, ".argus");
}

export interface SnapshotResult {
  ok: boolean;
  sha?: string;
  reason?: string;
}

export interface SnapshotOptions {
  repo: string;
  /** ISO-8601 stamp of the pass; the commit subject. */
  at: string;
  run?: GitRunner;
}

/** The two store dirs; everything else under `.argus/` is operational churn. */
const TRACKED = ["skills", "memory"];

export async function snapshotArgusState(
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const run = options.run ?? defaultGitRunner;
  const gitDir = backupGitDir(options.repo);
  const workTree = backupWorkTree(options.repo);
  const inRepo = (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    run(["--git-dir", gitDir, "--work-tree", workTree, ...args], workTree);

  const steps: [string, string[]][] = [
    ["init", ["init", "--quiet", "--bare", "--initial-branch=curator", gitDir]],
    ["config", ["--git-dir", gitDir, "config", "core.bare", "false"]],
  ];
  for (const [label, args] of steps) {
    const result = await run(args, options.repo);
    if (result.exitCode !== 0) {
      return { ok: false, reason: `${label}: ${(result.stderr || result.stdout).trim()}` };
    }
  }

  const staged = await inRepo(["add", "--all", "--", ...TRACKED]);
  if (staged.exitCode !== 0) {
    return { ok: false, reason: `add: ${(staged.stderr || staged.stdout).trim()}` };
  }
  // --allow-empty: an unchanged tree still gets a sha, so every pass has a
  // rollback point to name in its report.
  const committed = await inRepo([
    ...IDENTITY,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    `pre-curator snapshot ${options.at}`,
  ]);
  if (committed.exitCode !== 0) {
    return { ok: false, reason: `commit: ${(committed.stderr || committed.stdout).trim()}` };
  }
  const head = await inRepo(["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    return { ok: false, reason: `rev-parse: ${(head.stderr || head.stdout).trim()}` };
  }
  return { ok: true, sha: head.stdout.trim() };
}

export interface RestoreOptions {
  repo: string;
  sha: string;
  run?: GitRunner;
}

/**
 * Put the stores back as of a snapshot. Files created since (the `.archive/`
 * copies) are left alone — restoring is additive on purpose, so a rollback
 * can never itself destroy something.
 */
export async function restoreSnapshot(options: RestoreOptions): Promise<SnapshotResult> {
  const run = options.run ?? defaultGitRunner;
  const workTree = backupWorkTree(options.repo);
  const result = await run(
    [
      "--git-dir",
      backupGitDir(options.repo),
      "--work-tree",
      workTree,
      "checkout",
      options.sha,
      "--",
      ...TRACKED,
    ],
    workTree,
  );
  if (result.exitCode !== 0) {
    return { ok: false, reason: (result.stderr || result.stdout).trim() };
  }
  return { ok: true, sha: options.sha };
}
