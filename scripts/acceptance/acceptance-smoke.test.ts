import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../../src/eyes/test-budget.ts";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const PROCESS_BUDGET_MS = loadScaledMs(5_000, 60_000);
// Scenario evidence starts a complete composed §13 slot. Its work is real
// subprocess work, so it can take longer than the cheap probes when the full
// Bun suite is competing for CPU and process-launch capacity.
const SCENARIO_EVIDENCE_PROCESS_BUDGET_MS = loadScaledMs(10_000, 120_000);
const SCENARIO_EVIDENCE_TEST_BUDGET_MS = loadScaledMs(15_000, 180_000);
const TEST_BUDGET_MS = loadScaledMs(10_000, 120_000);

interface ScriptResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

async function runAcceptanceScript(
  name: string,
  processBudgetMs = PROCESS_BUDGET_MS,
): Promise<ScriptResult> {
  const script = join(checkout, "scripts", "acceptance", name);
  const root = await mkdtemp(join(tmpdir(), "argus-acceptance-smoke-"));
  const home = join(root, "home");
  const state = join(root, "state");
  await Promise.all([mkdir(home), mkdir(state)]);

  const inherited = Object.fromEntries(
    Object.entries(Bun.env).filter(
      ([name, value]) =>
        value !== undefined &&
        !name.startsWith("CMUX_") &&
        name !== "ANTHROPIC_API_KEY" &&
        name !== "ANTHROPIC_AUTH_TOKEN" &&
        name !== "CLAUDE_CODE_OAUTH_TOKEN" &&
        name !== "CODEX_SESSION_ID" &&
        name !== "CODEX_THREAD_ID" &&
        name !== "HONCHO_API_KEY" &&
        name !== "HONCHO_CONFIG_FILE" &&
        name !== "HONCHO_URL",
    ),
  ) as Record<string, string>;
  const env = {
    ...inherited,
    ARGUS_ACCEPTANCE_SMOKE: "1",
    ARGUS_LIVE_AGENTS: "0",
    ARGUS_REPOS_FILE: join(state, "argus-repos"),
    CLAUDE_CONFIG_DIR: join(state, "claude"),
    CODEX_HOME: join(state, "codex"),
    CMUX_SOCKET_DIR: join(state, "cmux"),
    CMUX_SOCKET_PATH: join(state, "cmux", "cmux.sock"),
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
      Bun.sleep(processBudgetMs).then(() => ({ exitCode: null, timedOut: true })),
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
}, TEST_BUDGET_MS);

test("the live agent drive executes its credential-free gate path", async () => {
  const result = await runAcceptanceScript("live-agents.ts");

  expect({ stderr: result.stderr, timedOut: result.timedOut }).toEqual({
    stderr: "",
    timedOut: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("argus: live agent drives SKIPPED");
}, TEST_BUDGET_MS);

test("the watcher stability probe runs its short real-process mode", async () => {
  const result = await runAcceptanceScript("watch-stability.ts");

  expect({ stderr: result.stderr, timedOut: result.timedOut }).toEqual({
    stderr: "",
    timedOut: false,
  });
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as {
    distinctPids: number;
    expectedEyes: number;
    mode?: string;
    pidsByEye: Record<string, number>;
  };
  expect(report.mode).toBe("smoke");
  expect(report.expectedEyes).toBeGreaterThan(0);
  expect(report.distinctPids).toBe(report.expectedEyes);
  expect(Object.values(report.pidsByEye)).toHaveLength(report.expectedEyes);
  expect(Object.values(report.pidsByEye).every((count) => count === 1)).toBe(true);
}, TEST_BUDGET_MS);

test("the scenario evidence reporter executes one composed scratch slot", async () => {
  const result = await runAcceptanceScript(
    "scenario-evidence.ts",
    SCENARIO_EVIDENCE_PROCESS_BUDGET_MS,
  );

  expect({ stderr: result.stderr, timedOut: result.timedOut }).toEqual({
    stderr: "",
    timedOut: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ARGUS §13 SCENARIO EVIDENCE SMOKE");
  expect(result.stdout).toContain("10. Blast-radius zero  ->  PASSED");
}, SCENARIO_EVIDENCE_TEST_BUDGET_MS);
