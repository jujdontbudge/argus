import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderSupervisorPlist } from "./plist.ts";

const liveTest = process.env.ARGUS_LIVE_LAUNCHD_SMOKE === "1" ? test : test.skip;

liveTest("live scratch launchd job restarts after death and unloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-launchd-live-"));
  const label = `dev.argus.live-smoke.${process.pid}.${Date.now()}`;
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const launches = join(root, "launches.log");
  const script = join(root, "scratch-supervisor.ts");
  const plistPath = join(root, `${label}.plist`);
  const service = `${domain}/${label}`;
  let loaded = false;

  try {
    await Bun.write(
      script,
      `import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(launches)}, String(process.pid) + "\\n");
await new Promise(() => {});
`,
    );
    await Bun.write(
      plistPath,
      renderSupervisorPlist({
        bunPath: process.execPath,
        cliPath: script,
        label,
        registryPath: join(root, "repos"),
        statusPath: join(root, "status.json"),
      }),
    );
    expect(
      Bun.spawnSync(["/bin/launchctl", "bootstrap", domain, plistPath]).exitCode,
    ).toBe(0);
    loaded = true;

    for (let attempt = 0; !(await Bun.file(launches).exists()) && attempt < 100; attempt += 1) {
      await Bun.sleep(20);
    }
    await Bun.sleep(200);
    const before = (await Bun.file(launches).text()).trim().split("\n");
    const killedPid = Number(before.at(-1));
    process.kill(killedPid, "SIGKILL");

    let after = before;
    for (let attempt = 0; after.length === before.length && attempt < 800; attempt += 1) {
      await Bun.sleep(20);
      after = (await Bun.file(launches).text()).trim().split("\n");
    }

    expect(Bun.spawnSync(["/bin/launchctl", "print", service]).exitCode).toBe(0);
    expect(after.length).toBeGreaterThan(before.length);
    expect(Number(after.at(-1))).not.toBe(killedPid);
  } finally {
    if (loaded) Bun.spawnSync(["/bin/launchctl", "bootout", service]);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
