import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGit } from "./git";

/** A throwaway git repo; every retro git test owns its own (SPEC §13 isolation). */
async function scratchRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "argus-retro-git-"));
  await git(dir, "init", "--quiet");
  await git(dir, "commit", "--quiet", "--allow-empty", "-m", "root commit");
  return { dir, cleanup: () => rm(dir, { force: true, recursive: true }) };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Retro Fixture",
      "-c",
      "user.email=retro@invalid.example",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function commitFile(
  dir: string,
  path: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(dir, path), contents);
  await git(dir, "add", path);
  await git(dir, "commit", "--quiet", "-m", message);
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

describe("git signal: commits in the repo", () => {
  test("a commit made after the cursor surfaces with its subject, files and diff", async () => {
    const repo = await scratchRepo();
    try {
      const baseline = (await git(repo.dir, "rev-parse", "HEAD")).trim();
      const sha = await commitFile(
        repo.dir,
        "widget.ts",
        "export const widget = 1;\n",
        "add the widget",
      );

      const scan = await scanGit({ repo: repo.dir, seen: [baseline] });

      expect(scan.repoRoot).toBe(await realDir(repo.dir));
      expect(scan.roots).toHaveLength(1);
      const [root] = scan.roots;
      expect(root!.commits.map((commit) => commit.sha)).toEqual([sha]);
      const [commit] = root!.commits;
      expect(commit!.subject).toBe("add the widget");
      expect(commit!.files).toEqual(["widget.ts"]);
      expect(commit!.diff).toContain("+export const widget = 1;");
      expect(commit!.authorEmail).toBe("retro@invalid.example");
      expect(scan.seen).toContain(sha);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  test("commits already in the cursor are not re-reported", async () => {
    const repo = await scratchRepo();
    try {
      const sha = await commitFile(repo.dir, "a.ts", "1\n", "first");
      const scan = await scanGit({ repo: repo.dir, seen: [sha] });
      expect(scan.roots.flatMap((root) => root.commits)).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});


describe("git signal: worktrees map to the parent repo (§7.3)", () => {
  test("a commit in a linked worktree is found from the main repo and mapped to it", async () => {
    const repo = await scratchRepo();
    const worktree = `${repo.dir}-wt`;
    try {
      const baseline = (await git(repo.dir, "rev-parse", "HEAD")).trim();
      await git(repo.dir, "worktree", "add", "--quiet", "-b", "build/rogue", worktree);
      const sha = await commitFile(
        worktree,
        "rogue.ts",
        "export const rogue = 1;\n",
        "rogue work",
      );

      const scan = await scanGit({ repo: repo.dir, seen: [baseline] });

      expect(scan.repoRoot).toBe(await realDir(repo.dir));
      const byDir = new Map(scan.roots.map((root) => [root.dir, root]));
      expect([...byDir.keys()].sort()).toEqual(
        [await realDir(repo.dir), await realDir(worktree)].sort(),
      );
      expect(
        byDir.get(await realDir(worktree))!.commits.map((commit) => commit.sha),
      ).toEqual([sha]);
      expect(byDir.get(await realDir(repo.dir))!.commits).toEqual([]);
      expect(scan.seen).toContain(sha);
    } finally {
      await rm(worktree, { force: true, recursive: true });
      await repo.cleanup();
    }
  }, 60_000);

  test("scanning from INSIDE a worktree still reports the parent repo as repoRoot", async () => {
    const repo = await scratchRepo();
    const worktree = `${repo.dir}-inside`;
    try {
      await git(repo.dir, "worktree", "add", "--quiet", "-b", "build/inside", worktree);
      const scan = await scanGit({ repo: worktree, seen: [] });
      expect(scan.repoRoot).toBe(await realDir(repo.dir));
      expect(scan.roots.map((root) => root.dir)).toContain(await realDir(worktree));
    } finally {
      await rm(worktree, { force: true, recursive: true });
      await repo.cleanup();
    }
  }, 60_000);
});

describe("git signal: uncommitted working-tree changes", () => {
  test("modified tracked files and brand-new untracked files both surface with a diff", async () => {
    const repo = await scratchRepo();
    try {
      await commitFile(repo.dir, "tracked.ts", "export const value = 1;\n", "seed");
      const baseline = (await git(repo.dir, "rev-parse", "HEAD")).trim();
      await writeFile(join(repo.dir, "tracked.ts"), "export const value = 2;\n");
      await writeFile(join(repo.dir, "untracked.ts"), "export const fresh = true;\n");

      const scan = await scanGit({ repo: repo.dir, seen: [baseline] });
      const working = scan.roots[0]!.workingTree;

      expect(working).not.toBeNull();
      expect(working!.files.sort()).toEqual(["tracked.ts", "untracked.ts"]);
      expect(working!.diff).toContain("+export const value = 2;");
      expect(working!.diff).toContain("+export const fresh = true;");
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  test("a clean working tree reports no working-tree change", async () => {
    const repo = await scratchRepo();
    try {
      const baseline = (await git(repo.dir, "rev-parse", "HEAD")).trim();
      const scan = await scanGit({ repo: repo.dir, seen: [baseline] });
      expect(scan.roots[0]!.workingTree).toBeNull();
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});

/** macOS temp dirs are symlinked through /private; compare resolved paths. */
async function realDir(dir: string): Promise<string> {
  return realpath(dir);
}

describe("git signal: Argus' own state is never work", () => {
  test("the .argus directory never surfaces as a working-tree change", async () => {
    const repo = await scratchRepo();
    try {
      const baseline = (await git(repo.dir, "rev-parse", "HEAD")).trim();
      await mkdir(join(repo.dir, ".argus/eyes/retro"), { recursive: true });
      await writeFile(join(repo.dir, ".argus/eyes/retro/state.json"), "{}\n");
      await writeFile(join(repo.dir, "real.ts"), "export const real = 1;\n");

      const working = (await scanGit({ repo: repo.dir, seen: [baseline] })).roots[0]!
        .workingTree;

      expect(working!.files).toEqual(["real.ts"]);
      expect(working!.diff).not.toContain(".argus");
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  test("a repo whose ONLY change is Argus state reports no working-tree change", async () => {
    const repo = await scratchRepo();
    try {
      const baseline = (await git(repo.dir, "rev-parse", "HEAD")).trim();
      await mkdir(join(repo.dir, ".argus/sessions"), { recursive: true });
      await writeFile(join(repo.dir, ".argus/sessions/INDEX.md"), "# Session index\n");

      const scan = await scanGit({ repo: repo.dir, seen: [baseline] });

      expect(scan.roots[0]!.workingTree).toBeNull();
    } finally {
      await repo.cleanup();
    }
  }, 60_000);
});
