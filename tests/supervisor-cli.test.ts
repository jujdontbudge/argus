import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const roots: string[] = [];

async function run(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, cli, ...command], {
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "argus-supervisor-cli-"));
  roots.push(root);
  const repoAPath = join(root, "repo-a");
  const repoBPath = join(root, "repo-b");
  const bin = join(root, "bin");
  await Promise.all([mkdir(repoAPath), mkdir(repoBPath), mkdir(bin)]);
  const [repoA, repoB] = await Promise.all([realpath(repoAPath), realpath(repoBPath)]);
  for (const repo of [repoA, repoB]) {
    const child = Bun.spawnSync(["git", "init", "--quiet"], { cwd: repo });
    expect(child.exitCode).toBe(0);
  }
  const launchctl = join(bin, "launchctl-fake");
  await Bun.write(
    launchctl,
    `#!/usr/bin/env bun
import { appendFile, rm } from "node:fs/promises";
const args = Bun.argv.slice(2);
await appendFile(Bun.env.FAKE_LAUNCHCTL_LOG!, JSON.stringify(args) + "\\n");
if (args[0] === "print") process.exit((await Bun.file(Bun.env.FAKE_LAUNCHCTL_STATE!).exists()) ? 0 : 113);
if (args[0] === "bootstrap") await Bun.write(Bun.env.FAKE_LAUNCHCTL_STATE!, "loaded\\n");
if (args[0] === "bootout") await rm(Bun.env.FAKE_LAUNCHCTL_STATE!, { force: true });
`,
  );
  await chmod(launchctl, 0o755);
  const env = {
    ARGUS_LAUNCHCTL: launchctl,
    ARGUS_LAUNCHD_DOMAIN: "gui/424242",
    ARGUS_REPOS_FILE: join(root, "state", "repos"),
    ARGUS_SUPERVISOR_LABEL: "dev.argus.scratch-cli",
    ARGUS_SUPERVISOR_PLIST: join(root, "state", "dev.argus.scratch-cli.plist"),
    ARGUS_SUPERVISOR_STATUS_FILE: join(root, "state", "status.json"),
    FAKE_LAUNCHCTL_LOG: join(root, "launchctl.jsonl"),
    FAKE_LAUNCHCTL_STATE: join(root, "launchctl.loaded"),
    HOME: join(root, "home"),
  };
  return { env, repoA, repoB, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("argus supervisor CLI", () => {
  test("status prints every enabled repo and eye as a readable process table", async () => {
    const { env, repoA, repoB } = await setup();
    await mkdir(join(env.ARGUS_REPOS_FILE, ".."), { recursive: true });
    await Bun.write(env.ARGUS_REPOS_FILE, `${repoA}\n${repoB}\n`);
    await Bun.write(
      env.ARGUS_SUPERVISOR_STATUS_FILE,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        watchers: [{ eye: "reviewer", pid: process.pid, repo: repoA, state: "running" }],
      }),
    );

    const result = await run(["status"], repoA, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("REPO");
    expect(result.stdout).toContain("EYE");
    expect(result.stdout).toContain(`${repoA}  reviewer  running  ${process.pid}`);
    expect(result.stdout).toContain(`${repoA}  archiver  stopped  -`);
    expect(result.stdout).toContain(`${repoB}  retro`);
  });

  test("down disables one repo, refreshes remaining watchers, then unloads the empty job", async () => {
    const { env, repoA, repoB } = await setup();
    await mkdir(join(env.ARGUS_REPOS_FILE, ".."), { recursive: true });
    await Bun.write(env.ARGUS_REPOS_FILE, `${repoA}\n${repoB}\n`);

    const first = await run(["down"], repoA, env);
    const second = await run(["down"], repoB, env);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(`Argus stopped ${repoA}`);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Supervisor unloaded (no enabled repos)");
    expect(await Bun.file(env.ARGUS_REPOS_FILE).text()).toBe("");
    const calls = (await Bun.file(env.FAKE_LAUNCHCTL_LOG).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toEqual([
      ["print", "gui/424242/dev.argus.scratch-cli"],
      ["bootstrap", "gui/424242", env.ARGUS_SUPERVISOR_PLIST],
      ["kickstart", "-k", "gui/424242/dev.argus.scratch-cli"],
      ["print", "gui/424242/dev.argus.scratch-cli"],
      ["bootout", "gui/424242/dev.argus.scratch-cli"],
    ]);
  });
});
