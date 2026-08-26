import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const oldBunPreload = fileURLToPath(
  new URL("./fixtures/old-bun.ts", import.meta.url),
);

async function runCli(
  args: string[],
  bunArgs: string[] = [],
  env: Record<string, string> = {},
  script = cli,
  cwd = checkout,
) {
  const child = Bun.spawn([process.execPath, ...bunArgs, script, ...args], {
    cwd,
    env: { ...Bun.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stderr, stdout };
}

describe("argus CLI", () => {
  test("--help lists the ticket-owned subcommands", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of [
      "up",
      "down",
      "status",
      "watch",
      "dispatch",
      "search",
      "install",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  test("dispatch outside a git repository refuses rather than guessing a repo", async () => {
    // Deliberately the ONLY `argus dispatch` case here: every other path
    // reaches real `gh` and spawns real agents, which SPEC §13 forbids a test
    // run from doing. The dispatcher itself is covered through its own
    // production entry point in src/dispatch/dispatch.test.ts.
    const outside = await mkdtemp(join(tmpdir(), "argus-not-a-repo-"));
    try {
      const result = await runCli(["dispatch"], [], {}, cli, outside);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not inside a git repository");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("startup refuses a Bun version below the hard floor", async () => {
    const result = await runCli(["--help"], ["--preload", oldBunPreload]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires Bun >= 1.3.12");
    expect(result.stderr).toContain("found 1.2.99");
  });

  test("watch rejects an unknown eye with the five valid names", async () => {
    const result = await runCli(["watch", "cyclops", "--repo", checkout]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown eye 'cyclops'");
    for (const eye of ["reviewer", "digest", "retro", "archiver", "honcho"]) {
      expect(result.stderr).toContain(eye);
    }
  });

  test("watch refuses an unenrolled repo instead of entering a restart loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-watch-unenrolled-"));
    const repo = join(root, "repo");
    const registry = join(root, "argus-repos");
    try {
      await mkdir(repo);
      await Bun.write(registry, "");

      const result = await runCli(
        ["watch", "reviewer", "--repo", repo],
        [],
        { ARGUS_REPOS_FILE: registry },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`repo is not enrolled: ${await realpath(repo)}`);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("install creates a launcher symlink under a scratch HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "argus-install-"));

    try {
      const result = await runCli(["install"], [], { HOME: home });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(await readlink(join(home, ".local/bin/argus"))).toBe(cli);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("install is idempotent when the launcher already points here", async () => {
    const home = await mkdtemp(join(tmpdir(), "argus-install-"));

    try {
      expect((await runCli(["install"], [], { HOME: home })).exitCode).toBe(0);

      const repeated = await runCli(["install"], [], { HOME: home });

      expect(repeated.exitCode).toBe(0);
      expect(repeated.stderr).toBe("");
      expect(await readlink(join(home, ".local/bin/argus"))).toBe(cli);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("install refuses to run from a non-checkout copy", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "argus-copy-"));
    const copiedSource = join(sandbox, "snapshot", "src", "cli.ts");
    const home = join(sandbox, "home");

    try {
      await mkdir(join(sandbox, "snapshot", "src"), { recursive: true });
      await mkdir(home);
      await copyFile(cli, copiedSource);

      const result = await runCli(
        ["install"],
        [],
        { HOME: home },
        copiedSource,
        join(sandbox, "snapshot"),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("must run from a git checkout");
      expect(await Bun.file(join(home, ".local/bin/argus")).exists()).toBe(false);
    } finally {
      await rm(sandbox, { force: true, recursive: true });
    }
  });

  test("the installed launcher is directly executable", async () => {
    const home = await mkdtemp(join(tmpdir(), "argus-install-"));

    try {
      expect((await runCli(["install"], [], { HOME: home })).exitCode).toBe(0);
      const launcher = join(home, ".local/bin/argus");
      const child = Bun.spawn([launcher, "--help"], {
        env: { ...Bun.env, HOME: home },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: argus <command>");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
