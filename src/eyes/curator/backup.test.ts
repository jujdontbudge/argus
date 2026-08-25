import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../retro/git";
import { backupGitDir, restoreSnapshot, snapshotArgusState } from "./backup";

async function git(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return stdout;
}

async function withRepo(body: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "argus-curator-backup-"));
  try {
    await git(["init", "--quiet", "--initial-branch=main", "."], repo);
    await Bun.write(join(repo, "README.md"), "target repo\n");
    await Bun.write(join(repo, ".gitignore"), ".argus\n");
    await git(["add", "-A"], repo);
    await git(
      ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "seed"],
      repo,
    );
    await mkdir(join(repo, ".argus/skills/keeper"), { recursive: true });
    await Bun.write(
      join(repo, ".argus/skills/keeper/SKILL.md"),
      "---\nname: keeper\n---\n\noriginal\n",
    );
    await mkdir(join(repo, ".argus/memory"), { recursive: true });
    await Bun.write(join(repo, ".argus/memory/fact.md"), "a fact\n");
    await body(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
}

const AT = "2026-08-24T12:00:00.000Z";

describe("the pre-pass backup — a git commit of the stores, not of the repo", () => {
  test("a snapshot commits skills and memory and returns its sha", async () => {
    await withRepo(async (repo) => {
      const result = await snapshotArgusState({ repo, at: AT });
      expect(result.ok).toBe(true);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

      const listed = await git(
        ["--git-dir", backupGitDir(repo), "show", "--name-only", "--format=", result.sha!],
        repo,
      );
      expect(listed).toContain("skills/keeper/SKILL.md");
      expect(listed).toContain("memory/fact.md");
    });
  });

  test("the target repo's history and working tree are untouched", async () => {
    await withRepo(async (repo) => {
      const before = await git(["log", "--format=%H"], repo);
      await snapshotArgusState({ repo, at: AT });
      expect(await git(["log", "--format=%H"], repo)).toBe(before);
      // `.argus/` is gitignored (SPEC §4), so the snapshot cannot live in the
      // target repo's history — and must not dirty its tree either.
      expect(await git(["status", "--porcelain"], repo)).toBe("");
    });
  });

  test("a later pass snapshots again; the earlier snapshot is still reachable", async () => {
    await withRepo(async (repo) => {
      const first = await snapshotArgusState({ repo, at: AT });
      await Bun.write(
        join(repo, ".argus/skills/keeper/SKILL.md"),
        "---\nname: keeper\n---\n\nedited\n",
      );
      const second = await snapshotArgusState({ repo, at: "2026-08-31T12:00:00.000Z" });

      expect(second.sha).not.toBe(first.sha);
      const old = await git(
        ["--git-dir", backupGitDir(repo), "show", `${first.sha}:skills/keeper/SKILL.md`],
        repo,
      );
      expect(old).toContain("original");
    });
  });

  test("rollback brings an archived-away skill back — the guarantee the backup exists for", async () => {
    await withRepo(async (repo) => {
      const snapshot = await snapshotArgusState({ repo, at: AT });
      await rm(join(repo, ".argus/skills/keeper"), { force: true, recursive: true });

      await restoreSnapshot({ repo, sha: snapshot.sha! });

      expect(
        await Bun.file(join(repo, ".argus/skills/keeper/SKILL.md")).text(),
      ).toContain("original");
    });
  });

  test("a failing git is reported, never thrown — a bad snapshot must not block the pass", async () => {
    await withRepo(async (repo) => {
      const broken: GitRunner = async () => ({
        exitCode: 127,
        stdout: "",
        stderr: "git: command not found",
      });
      const result = await snapshotArgusState({ repo, at: AT, run: broken });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("command not found");
    });
  });
});
