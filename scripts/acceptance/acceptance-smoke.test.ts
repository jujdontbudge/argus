import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const liveSweep = join(checkout, "scripts", "acceptance", "live-sweep.ts");

test("the live sweep cheaply proves daemon and sandbox supervisor behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-acceptance-smoke-"));
  const home = join(root, "home");
  const state = join(root, "state");
  await Promise.all([mkdir(home), mkdir(state)]);

  const inherited = Object.fromEntries(
    Object.entries(Bun.env).filter(
      ([name, value]) =>
        value !== undefined &&
        name !== "ANTHROPIC_API_KEY" &&
        name !== "ANTHROPIC_AUTH_TOKEN" &&
        name !== "CLAUDE_CODE_OAUTH_TOKEN" &&
        name !== "HONCHO_API_KEY",
    ),
  ) as Record<string, string>;
  const env = {
    ...inherited,
    ARGUS_ACCEPTANCE_SMOKE: "1",
    ARGUS_REPOS_FILE: join(state, "argus-repos"),
    CLAUDE_CONFIG_DIR: join(state, "claude"),
    CODEX_HOME: join(state, "codex"),
    HERMES_HOME: join(state, "hermes"),
    HOME: home,
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_CONFIG_HOME: join(state, "config"),
    XDG_DATA_HOME: join(state, "data"),
    XDG_STATE_HOME: join(state, "xdg-state"),
  };

  try {
    const child = Bun.spawn([process.execPath, liveSweep], {
      cwd: checkout,
      detached: true,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
      Bun.sleep(5_000).then(() => ({ exitCode: null, timedOut: true })),
    ]);
    if (outcome.timedOut) {
      process.kill(-child.pid, "SIGTERM");
      await child.exited;
    }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    expect({ stderr, timedOut: outcome.timedOut }).toEqual({
      stderr: "",
      timedOut: false,
    });
    expect(outcome.exitCode).toBe(0);
    expect(stdout).toContain("SMOKE PASS  watch daemon stayed alive until signalled");
    expect(stdout).toContain("SMOKE PASS  sandbox supervisor watcher PIDs stayed stable");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 10_000);
