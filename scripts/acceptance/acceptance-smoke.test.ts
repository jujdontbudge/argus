import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../..", import.meta.url));

interface ScriptResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

async function runAcceptanceScript(name: string): Promise<ScriptResult> {
  const script = join(checkout, "scripts", "acceptance", name);
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
    ARGUS_LIVE_AGENTS: "0",
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
    const child = Bun.spawn([process.execPath, script], {
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
    return { ...outcome, stderr, stdout };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("the live sweep cheaply proves daemon and sandbox supervisor behavior", async () => {
  const result = await runAcceptanceScript("live-sweep.ts");

  expect({ stderr: result.stderr, timedOut: result.timedOut }).toEqual({
    stderr: "",
    timedOut: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    "SMOKE PASS  watch daemon stayed alive until signalled",
  );
  expect(result.stdout).toContain(
    "SMOKE PASS  sandbox supervisor watcher PIDs stayed stable",
  );
}, 10_000);

test("the live agent drive executes its credential-free gate path", async () => {
  const result = await runAcceptanceScript("live-agents.ts");

  expect({ stderr: result.stderr, timedOut: result.timedOut }).toEqual({
    stderr: "",
    timedOut: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("argus: live agent drives SKIPPED");
}, 10_000);
