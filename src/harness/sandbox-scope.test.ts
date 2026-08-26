import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { adoptSandboxWatchers, SandboxScope } from "./sandbox-scope.ts";

test("a path inside the sandbox is returned; one outside is refused by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-scope-"));
  const scope = new SandboxScope(root);

  expect(scope.path(join(root, "scratch/.argus"), "wipe")).toBe(
    join(root, "scratch/.argus"),
  );
  expect(() => scope.path(join(homedir(), ".claude"), "wipe")).toThrow(
    "sandbox scope refused wipe",
  );
});

test("remove deletes inside the sandbox and refuses a symlink that leaves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "argus-outside-"));
  const scope = new SandboxScope(root);

  const doomed = join(root, "scratch/.argus");
  await mkdir(doomed, { recursive: true });
  await Bun.write(join(doomed, "archive.db"), "sandbox state");
  await scope.remove(doomed);
  expect(await Bun.file(join(doomed, "archive.db")).exists()).toBe(false);

  // The escape a lexical check waves through: the path is under the sandbox
  // root, but what it POINTS AT is not. This is the destructive-op leak the
  // scope exists to stop, so the assertion is that the real tree SURVIVES.
  const decoy = join(outside, "precious.txt");
  await Bun.write(decoy, "not the sandbox's to delete");
  await symlink(outside, join(root, "escape-hatch"));

  expect(scope.remove(join(root, "escape-hatch"))).rejects.toThrow(
    "sandbox scope refused remove",
  );
  expect(await Bun.file(decoy).text()).toBe("not the sandbox's to delete");
});

test("kill signals an adopted pid and refuses one this harness never spawned", async () => {
  const scope = new SandboxScope(await mkdtemp(join(tmpdir(), "argus-scope-")));
  const alive = () => (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const isAlive = alive();
  // Both are children of THIS test, so nothing real is ever at risk. The
  // bystander stands in for what actually shares this machine: the production
  // dispatcher and Johan's live Claude sessions. Scenario 6 SIGKILLs watchers
  // by pid, and the failure mode being pinned here is a kill that matches
  // more than the harness started.
  const mine = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

  try {
    scope.adopt(mine.pid);

    expect(() => scope.kill(bystander.pid, "SIGKILL")).toThrow(
      "sandbox scope refused kill",
    );
    expect(isAlive(bystander.pid)).toBe(true);

    scope.kill(mine.pid, "SIGKILL");
    for (let attempt = 0; isAlive(mine.pid) && attempt < 200; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(isAlive(mine.pid)).toBe(false);
    expect(isAlive(bystander.pid)).toBe(true);
  } finally {
    bystander.kill("SIGKILL");
    mine.kill("SIGKILL");
    await Promise.all([bystander.exited, mine.exited]);
  }
});

test("only watchers belonging to THIS sandbox are adoptable, so a kill cannot reach the dispatcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-scope-"));
  const scope = new SandboxScope(root);
  const repo = join(root, "scratch-repo");

  // The shape scenario 6 actually reads. The second row is the hazard in
  // one line: this machine runs the production dispatcher's watchers over
  // the REAL ~/argus at the same time as the harness runs its own, and both
  // land in a supervisor status file as `{eye, pid, repo}`.
  const adopted = adoptSandboxWatchers(scope, repo, {
    watchers: [
      { eye: "archiver", pid: 4242, repo },
      { eye: "archiver", pid: 9999, repo: join(homedir(), "argus") },
      { eye: "digest", pid: 4243, repo: join(repo, "..", "elsewhere") },
    ],
  });

  expect(adopted).toEqual([4242]);
  expect(() => scope.kill(9999, "SIGKILL")).toThrow(
    "sandbox scope refused kill: pid 9999 was not spawned by this harness",
  );
  expect(() => scope.kill(4243, "SIGKILL")).toThrow("sandbox scope refused kill");
});

test("the sandbox scope refuses every real path SPEC §13 names", async () => {
  const scope = new SandboxScope(await mkdtemp(join(tmpdir(), "argus-scope-")));

  for (const real of [
    join(homedir(), ".claude"),
    join(homedir(), ".hermes"),
    join(homedir(), ".argus-repos"),
    join(homedir(), "argus"),
    homedir(),
  ]) {
    expect(() => scope.path(real, "wipe")).toThrow("sandbox scope refused wipe");
    expect(scope.remove(real)).rejects.toThrow("sandbox scope refused remove");
  }
});
