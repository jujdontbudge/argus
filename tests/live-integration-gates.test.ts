import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function runLiveTest(
  file: string,
  env: Record<string, string>,
  preload?: string,
): Promise<{ exitCode: number; output: string }> {
  const command = [process.execPath, "test"];
  if (preload) command.push("--preload", preload);
  command.push(file);
  const child = Bun.spawn(command, {
    cwd: repo,
    env: { ...Bun.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

test("an installed codex binary cannot run any live watcher-brain test without explicit opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-live-gate-codex-"));
  sandboxes.push(root);
  const bin = join(root, "bin");
  const marker = join(root, "codex-was-invoked");
  const fakeCodex = join(bin, "codex");
  await mkdir(bin);
  await Bun.write(
    fakeCodex,
    '#!/bin/sh\nprintf invoked > "$ARGUS_TEST_LIVE_MARKER"\nexit 1\n',
  );
  await chmod(fakeCodex, 0o755);

  for (const file of [
    "src/eyes/reviewer/live.test.ts",
    "src/eyes/retro/live.test.ts",
    "src/eyes/curator/live.test.ts",
  ]) {
    const result = await runLiveTest(file, {
      ARGUS_LIVE_WATCHER_BRAINS: "",
      ARGUS_TEST_LIVE_MARKER: marker,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
    });

    expect(await Bun.file(marker).exists(), file).toBe(false);
    expect(result.exitCode, file).toBe(0);
    expect(result.output, file).toContain("SKIPPED");
    expect(result.output, file).toContain("ARGUS_LIVE_WATCHER_BRAINS");
  }
});

test("configured Honcho credentials cannot probe or mutate a service without explicit opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-live-gate-honcho-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const marker = join(root, "fetch-was-invoked");
  const preload = join(root, "intercept-fetch.ts");
  await mkdir(home);
  await Bun.write(
    preload,
    `globalThis.fetch = async () => {
  await Bun.write(Bun.env.ARGUS_TEST_LIVE_MARKER!, "fetch invoked");
  return new Response(null, { status: 503 });
};
`,
  );

  const result = await runLiveTest(
    "src/eyes/honcho/live.test.ts",
    {
      ARGUS_LIVE_HONCHO: "",
      ARGUS_TEST_LIVE_MARKER: marker,
      HOME: home,
      HONCHO_API_KEY: "scratch-key-that-must-not-be-read",
    },
    preload,
  );

  expect(await Bun.file(marker).exists()).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("SKIPPED");
  expect(result.output).toContain("ARGUS_LIVE_HONCHO");
});

test("gated deploy integrations report their subscription and network skips", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-live-gate-deploy-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const marker = join(root, "agent-was-invoked");
  await Promise.all([mkdir(home), mkdir(bin)]);
  const fakeAgent =
    '#!/bin/sh\nprintf invoked > "$ARGUS_TEST_LIVE_MARKER"\nexit 1\n';
  await Bun.write(join(bin, "codex"), fakeAgent);
  await chmod(join(bin, "codex"), 0o755);

  const result = await runLiveTest("src/deploy/live.test.ts", {
    ARGUS_LIVE_AGENTS: "",
    ARGUS_LIVE_CLAUDE_SUBSCRIPTION: "",
    ARGUS_LIVE_CODEX_DEPLOY: "",
    ARGUS_TEST_LIVE_MARKER: marker,
    HOME: home,
    PATH: `${bin}:${Bun.env.PATH ?? ""}`,
  });

  expect(await Bun.file(marker).exists()).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("SKIPPED");
  expect(result.output).toContain("ARGUS_LIVE_CLAUDE_SUBSCRIPTION");
  expect(result.output).toContain("ARGUS_LIVE_CODEX_DEPLOY");
});
