import { expect, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeLiveIntegrationGate } from "../eyes/live-gate.ts";
import { liveHalfTitle } from "../harness/live-gate.ts";
import {
  LIVE_LAUNCHD_SMOKE_GATE,
  resolveLaunchdSmokeGate,
} from "./launchd-live-gate.ts";
import { renderSupervisorPlist } from "./plist.ts";

const launchctl = "/bin/launchctl";
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const codexPath = Bun.which("codex");
const ghPath = Bun.which("gh");

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const gate = resolveLaunchdSmokeGate({
  codexPath,
  env: Bun.env,
  ghPath,
  launchctlAvailable: executable(launchctl),
  platform: process.platform,
});
console.log(
  describeLiveIntegrationGate(
    "live launchd smoke",
    LIVE_LAUNCHD_SMOKE_GATE,
    gate,
  ),
);

function launchctlRun(...args: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const result = Bun.spawnSync([launchctl, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function serviceLabels(domainOutput: string): string[] {
  const services = domainOutput.match(/\n\tservices = \{\n([\s\S]*?)\n\t\}/)?.[1] ?? "";
  return services
    .split("\n")
    .map((line) => line.match(/^\s*(?:-|\d+)\s+\S+\s+(\S+)\s*$/)?.[1])
    .filter((label): label is string => label !== undefined)
    .sort();
}

function labelDiff(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...before.filter((label) => !afterSet.has(label)).map((label) => `- ${label}`),
    ...after.filter((label) => !beforeSet.has(label)).map((label) => `+ ${label}`),
  ];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const liveTest = gate.status === "run" ? test : test.skip;

liveTest(
  liveHalfTitle(
    "real scratch launchd job resolves tools, degrades failed eyes, and unloads",
    gate,
  ),
  async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-launchd-live-"));
    const home = join(root, "home");
    const codexHome = join(root, "codex-home");
    const hermesHome = join(root, "hermes-home");
    const claudeConfig = join(root, "claude-config");
    const repoPath = join(root, "repo");
    const registryPath = join(root, "repos");
    const statusPath = join(root, "supervisor-status.json");
    const probePath = join(root, "launchd-environment.txt");
    const wrapperPath = join(root, "launchd-entry.sh");
    const label = `com.argus.test.launchd-smoke.${process.pid}.${Date.now()}`;
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const service = `${domain}/${label}`;
    const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
    const explicitCodex = codexPath!;
    const explicitGh = ghPath!;
    const explicitPath = [
      dirname(explicitCodex),
      dirname(explicitGh),
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].filter((value, index, values) => values.indexOf(value) === index).join(":");
    let loaded = false;
    let bootout = { exitCode: -1, stderr: "not attempted", stdout: "" };
    let statusResult = { exitCode: -1, stderr: "not attempted", stdout: "" };
    let servicePrint = { exitCode: -1, stderr: "not attempted", stdout: "" };
    let probe = "not written";
    let plist = "not written";
    let ownedPids: number[] = [];
    let survivors: number[] = [];
    let beforeLabels: string[] = [];
    let afterLabels: string[] = [];

    try {
      const before = launchctlRun("print", domain);
      if (before.exitCode !== 0) {
        throw new Error(`launchctl print ${domain} failed: ${before.stderr.trim()}`);
      }
      beforeLabels = serviceLabels(before.stdout);

      await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(codexHome, { recursive: true }),
        mkdir(hermesHome, { recursive: true }),
        mkdir(claudeConfig, { recursive: true }),
        mkdir(join(repoPath, ".argus"), { recursive: true }),
      ]);
      const git = Bun.spawnSync(["/usr/bin/git", "init", "--quiet", repoPath]);
      if (git.exitCode !== 0) throw new Error("could not initialize scratch repo");
      const repo = await realpath(repoPath);
      await Promise.all([
        Bun.write(
          join(repo, ".argus", "config.yaml"),
          "brain:\n  model: argus-live-smoke-invalid\n",
        ),
        Bun.write(
          join(repo, ".argus", "honcho.yaml"),
          "url: http://127.0.0.1:1\nworkspace: argus-live-smoke\n",
        ),
        Bun.write(registryPath, `${repo}\n`),
        Bun.write(
          wrapperPath,
          `#!/bin/sh\n` +
            `{\n` +
            `  printf 'PATH=%s\\n' "$PATH"\n` +
            `  printf 'ARGUS_CODEX_EXECUTABLE=%s\\n' "$ARGUS_CODEX_EXECUTABLE"\n` +
            `  printf 'ARGUS_GH_EXECUTABLE=%s\\n' "$ARGUS_GH_EXECUTABLE"\n` +
            `  printf 'HOME=%s\\n' "$HOME"\n` +
            `  printf 'CODEX_HOME=%s\\n' "$CODEX_HOME"\n` +
            `  printf 'HERMES_HOME=%s\\n' "$HERMES_HOME"\n` +
            `  printf 'CLAUDE_CONFIG_DIR=%s\\n' "$CLAUDE_CONFIG_DIR"\n` +
            `  printf 'command -v codex='; command -v codex\n` +
            `  printf 'command -v gh='; command -v gh\n` +
            `} > ${JSON.stringify(probePath)}\n` +
            `exec ${JSON.stringify(process.execPath)} "$@"\n`,
        ),
      ]);
      await chmod(wrapperPath, 0o700);
      plist = renderSupervisorPlist({
        bunPath: wrapperPath,
        claudeConfigPath: claudeConfig,
        cliPath: cli,
        codexHomePath: codexHome,
        codexPath: explicitCodex,
        ghPath: explicitGh,
        hermesHomePath: hermesHome,
        homePath: home,
        label,
        path: explicitPath,
        registryPath,
        statusPath,
      });
      await mkdir(dirname(plistPath), { recursive: true });
      await Bun.write(plistPath, plist);

      const bootstrap = launchctlRun("bootstrap", domain, plistPath);
      if (bootstrap.exitCode !== 0) {
        throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}`);
      }
      loaded = true;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await Bun.file(statusPath).exists()) {
          const status = await Bun.file(statusPath).json().catch(() => null) as
            | { watchers?: Array<{ pid: number }> }
            | null;
          if (status?.watchers?.length === 5) break;
        }
        await Bun.sleep(50);
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const health = Bun.file(join(repoPath, ".argus", "eyes", "reviewer", "health.json"));
        if (await health.exists()) {
          const value = await health.json().catch(() => null) as
            | { lastError?: unknown }
            | null;
          if (value?.lastError) break;
        }
        await Bun.sleep(50);
      }

      const status = await Bun.file(statusPath).json() as {
        watchers: Array<{ pid: number }>;
      };
      ownedPids = status.watchers.map(({ pid }) => pid);
      servicePrint = launchctlRun("print", service);
      const statusChild = Bun.spawnSync(
        [process.execPath, cli, "status"],
        {
          env: {
            HOME: home,
            CODEX_HOME: codexHome,
            HERMES_HOME: hermesHome,
            CLAUDE_CONFIG_DIR: claudeConfig,
            PATH: explicitPath,
            ARGUS_REPOS_FILE: registryPath,
            ARGUS_SUPERVISOR_STATUS_FILE: statusPath,
            ARGUS_SUPERVISOR_CONTROL: "disabled",
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      statusResult = {
        exitCode: statusChild.exitCode,
        stderr: statusChild.stderr.toString(),
        stdout: statusChild.stdout.toString(),
      };
      probe = await Bun.file(probePath).text();

      bootout = launchctlRun("bootout", service);
      if (bootout.exitCode === 0) loaded = false;
    } finally {
      if (loaded) bootout = launchctlRun("bootout", service);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (launchctlRun("print", service).exitCode !== 0) break;
        await Bun.sleep(20);
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        survivors = ownedPids.filter(alive);
        if (survivors.length === 0) break;
        await Bun.sleep(20);
      }
      const after = launchctlRun("print", domain);
      afterLabels = after.exitCode === 0 ? serviceLabels(after.stdout) : [];
      await rm(root, { force: true, recursive: true });
    }

    const beforeArgus = beforeLabels.filter((candidate) => /argus/i.test(candidate));
    const afterArgus = afterLabels.filter((candidate) => /argus/i.test(candidate));
    const fullDiff = labelDiff(beforeLabels, afterLabels);
    console.log(`launchd live evidence:`);
    console.log(`  label: ${label}`);
    console.log(`  scratch HOME: ${home}`);
    console.log(`  launchctl labels before: ${beforeLabels.length}`);
    console.log(`  launchctl labels after:  ${afterLabels.length}`);
    console.log(`  launchctl label diff: ${fullDiff.length === 0 ? "(empty)" : fullDiff.join(", ")}`);
    console.log(`  argus labels before: ${JSON.stringify(beforeArgus)}`);
    console.log(`  argus labels after:  ${JSON.stringify(afterArgus)}`);
    console.log(`  launchctl service print exit: ${servicePrint.exitCode}`);
    console.log(`  environment probe:\n${probe.trimEnd().replaceAll(/^/gm, "    ")}`);
    console.log(`  argus status exit: ${statusResult.exitCode}`);
    console.log(statusResult.stdout.trimEnd().replaceAll(/^/gm, "    "));
    console.log(`  launchctl bootout exit: ${bootout.exitCode}`);
    console.log(`  owned watcher pids: ${JSON.stringify(ownedPids)}`);
    console.log(`  owned survivors after bootout: ${JSON.stringify(survivors)}`);
    console.log(`  scratch root exists after cleanup: ${await Bun.file(root).exists()}`);

    expect(plist).toContain(`<key>PATH</key>\n    <string>${explicitPath}</string>`);
    expect(plist).toContain(
      `<key>ARGUS_CODEX_EXECUTABLE</key>\n    <string>${explicitCodex}</string>`,
    );
    expect(plist).toContain(
      `<key>ARGUS_GH_EXECUTABLE</key>\n    <string>${explicitGh}</string>`,
    );
    expect(servicePrint.exitCode).toBe(0);
    expect(probe).toContain(`command -v codex=${explicitCodex}\n`);
    expect(probe).toContain(`command -v gh=${explicitGh}\n`);
    expect(statusResult.exitCode).toBe(1);
    expect(statusResult.stdout).toMatch(/reviewer\s+degraded/);
    expect(statusResult.stdout).toContain("is not reachable via codex exec");
    expect(bootout.exitCode).toBe(0);
    expect(beforeLabels.length).toBeGreaterThan(0);
    expect(afterArgus).toEqual(beforeArgus);
    expect(afterLabels).not.toContain(label);
    expect(survivors).toEqual([]);
    expect(await Bun.file(root).exists()).toBe(false);
  },
  20_000,
);
