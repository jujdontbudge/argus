import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convergeSupervisorJob,
  unloadSupervisorJob,
  type Launchctl,
} from "./launchd.ts";

const roots: string[] = [];

class FakeLaunchctl implements Launchctl {
  calls: string[] = [];
  loaded = false;

  async bootstrap(plistPath: string): Promise<void> {
    this.calls.push(`bootstrap ${plistPath}`);
    this.loaded = true;
  }

  async bootout(): Promise<void> {
    this.calls.push("bootout");
    this.loaded = false;
  }

  async isLoaded(): Promise<boolean> {
    this.calls.push("is-loaded");
    return this.loaded;
  }

  async kickstart(): Promise<void> {
    this.calls.push("kickstart");
  }
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "argus-launchd-"));
  roots.push(root);
  return {
    bunPath: "/scratch/bun",
    cliPath: "/scratch/argus/src/cli.ts",
    label: "dev.argus.scratch",
    plistPath: join(root, "dev.argus.scratch.plist"),
    registryPath: join(root, "repos"),
    statusPath: join(root, "status.json"),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("launchd supervisor job", () => {
  test("writes once, reloads only when the rendered plist changes, and kickstarts now", async () => {
    const options = await scratch();
    const launchctl = new FakeLaunchctl();

    const first = await convergeSupervisorJob(options, launchctl);
    const firstBytes = await Bun.file(options.plistPath).text();
    const repeated = await convergeSupervisorJob(options, launchctl);
    const changed = await convergeSupervisorJob(
      { ...options, cliPath: "/scratch/argus-next/src/cli.ts" },
      launchctl,
    );

    expect(first).toEqual({ changed: true, reloaded: false });
    expect(repeated).toEqual({ changed: false, reloaded: false });
    expect(changed).toEqual({ changed: true, reloaded: true });
    expect(firstBytes).toContain("/scratch/argus/src/cli.ts");
    expect(launchctl.calls).toEqual([
      "is-loaded",
      `bootstrap ${options.plistPath}`,
      "kickstart",
      "is-loaded",
      "is-loaded",
      "bootout",
      `bootstrap ${options.plistPath}`,
      "kickstart",
    ]);
  });

  test("dry-run returns exact plist bytes without writing or contacting launchd", async () => {
    const options = await scratch();
    const launchctl = new FakeLaunchctl();

    const result = await convergeSupervisorJob(
      { ...options, dryRun: true },
      launchctl,
    );

    expect(result.plist).toContain("<string>dev.argus.scratch</string>");
    expect(await Bun.file(options.plistPath).exists()).toBe(false);
    expect(launchctl.calls).toEqual([]);
  });

  test("unloads cleanly and is idempotent when no enabled repos remain", async () => {
    const options = await scratch();
    const launchctl = new FakeLaunchctl();
    await convergeSupervisorJob(options, launchctl);
    launchctl.calls = [];

    expect(await unloadSupervisorJob(launchctl)).toBe(true);
    expect(await unloadSupervisorJob(launchctl)).toBe(false);
    expect(launchctl.calls).toEqual(["is-loaded", "bootout", "is-loaded"]);
  });
});
