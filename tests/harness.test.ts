import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSandbox,
  createScenarioRegistry,
  mechanicsScenario,
  runScenario,
  runScenarios,
  SimulationDriverRunner,
  type AgentSpawnRequest,
} from "../src/harness/index.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));

describe("fake-Johan harness", () => {
  test("creates an isolated throwaway git repo and records the argus up stub", async () => {
    const sandbox = await createSandbox({ checkout });

    try {
      expect((await lstat(join(sandbox.repo, ".git"))).isDirectory()).toBe(true);
      expect(sandbox.home).toBe(join(sandbox.root, "home"));
      expect(sandbox.env.HOME).toBe(sandbox.home);
      expect(sandbox.env.XDG_CONFIG_HOME).toBe(join(sandbox.root, "state/config"));
      expect(sandbox.env.XDG_CACHE_HOME).toBe(join(sandbox.root, "state/cache"));
      expect(sandbox.env.XDG_DATA_HOME).toBe(join(sandbox.root, "state/data"));
      expect(sandbox.env.XDG_STATE_HOME).toBe(join(sandbox.root, "state/state"));
      expect(sandbox.env.ARGUS_REPOS_DIR).toBe(join(sandbox.root, "state/argus-repos"));
      expect(sandbox.env.CLAUDE_CONFIG_DIR).toBe(join(sandbox.root, "state/claude"));
      expect(sandbox.env.CODEX_HOME).toBe(join(sandbox.root, "state/codex"));
      expect(sandbox.env.HERMES_HOME).toBe(join(sandbox.root, "state/hermes"));
      expect(sandbox.env.CMUX_SOCKET_DIR).toBe(join(sandbox.root, "state/cmux"));
      expect(sandbox.env.CMUX_SOCKET_PATH).toBe(join(sandbox.root, "state/cmux/cmux.sock"));
      expect(
        Object.keys(sandbox.env)
          .filter((name) => name.startsWith("CMUX_"))
          .sort(),
      ).toEqual(["CMUX_SOCKET_DIR", "CMUX_SOCKET_PATH"]);
      expect(dirname(sandbox.repo)).toBe(sandbox.root);
      expect(sandbox.up).toEqual({
        exitCode: 1,
        stderr: "argus up: not implemented yet\n",
        stdout: "",
      });
    } finally {
      await sandbox.teardown();
    }

    expect(lstat(sandbox.root)).rejects.toThrow();
  }, 90_000);

  test("simulation driver delegates pinned agents to isolated worktrees and tabs", async () => {
    const sandbox = await createSandbox({ checkout });
    const requests: AgentSpawnRequest[] = [];
    const driver = new SimulationDriverRunner({
      spawn: async (request) => {
        requests.push(request);
        return { exitCode: 0 };
      },
    });

    try {
      await driver.spawnTestAgents(sandbox);

      expect(
        requests
          .map(({ agent, command }) => ({ agent, command }))
          .sort((left, right) => left.agent.localeCompare(right.agent)),
      ).toEqual([
        { agent: "claude", command: ["claude", "--model", "claude-opus-5"] },
        { agent: "codex", command: ["codex", "-c", "model_reasoning_effort=high"] },
      ]);
      expect(new Set(requests.map(({ cwd }) => cwd)).size).toBe(2);
      expect(new Set(requests.map(({ tab }) => tab)).size).toBe(2);

      for (const request of requests) {
        expect(request.cwd.startsWith(join(sandbox.root, "worktrees/"))).toBe(true);
        expect(request.tab.startsWith(`argus-test-${sandbox.id}-`)).toBe(true);
        expect(request.env).toEqual(sandbox.env);
        const child = Bun.spawn(
          ["git", "-C", request.cwd, "rev-parse", "--is-inside-work-tree"],
          { stderr: "pipe", stdout: "pipe" },
        );
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stdout).text()).toBe("true\n");
      }
    } finally {
      await sandbox.teardown();
    }
  }, 90_000);

  test("registry exposes all ten core scenario slots and accepts future implementations", () => {
    const registry = createScenarioRegistry();

    expect(registry.list()).toEqual([
      { number: 1, status: "unimplemented", title: "Autonomous batch, zero human input" },
      { number: 2, status: "unimplemented", title: "Fake-Johan takeover" },
      { number: 3, status: "unimplemented", title: "Rogue session" },
      { number: 4, status: "unimplemented", title: "The poisoning test" },
      { number: 5, status: "unimplemented", title: "Fault injection: the unlogged send" },
      { number: 6, status: "unimplemented", title: "Watcher death" },
      { number: 7, status: "unimplemented", title: "Signal paths" },
      { number: 8, status: "unimplemented", title: "Self-learning loop" },
      { number: 9, status: "unimplemented", title: "Semantic isolation" },
      { number: 10, status: "unimplemented", title: "Blast-radius zero" },
    ]);

    registry.register(3, async () => {});

    expect(registry.list()[2]).toEqual({
      number: 3,
      status: "implemented",
      title: "Rogue session",
    });
    expect(registry.get(3)).toBeFunction();
  });

  test("mechanics scenario proves machine-state isolation, tears down, and writes a report", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));

    try {
      const result = await runScenario({
        checkout,
        name: "mechanics-isolation",
        reportDirectory,
        scenario: mechanicsScenario,
      });

      expect(result.status).toBe("passed");
      expect(result.assertions.map(({ description }) => description)).toEqual([
        "real ~/.local/bin is outside the sandbox boundary",
        "real ~/.argus-repos is outside the sandbox boundary",
        "real ~/.claude is outside the sandbox boundary",
        "real ~/.hermes is outside the sandbox boundary",
        "real ~/argus is outside the sandbox boundary",
        "production cmux is outside the sandbox boundary",
      ]);
      expect(lstat(result.sandboxRoot)).rejects.toThrow();

      const artifact = await Bun.file(result.reportPath).json();
      expect(artifact).toEqual({
        assertions: result.assertions,
        error: null,
        id: result.id,
        name: "mechanics-isolation",
        sandboxRoot: result.sandboxRoot,
        status: "passed",
        teardown: "completed",
        up: {
          exitCode: 1,
          stderr: "argus up: not implemented yet\n",
          stdout: "",
        },
      });
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);

  test("scenario crash still tears down its sandbox and records failure", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));

    try {
      const result = await runScenario({
        checkout,
        name: "deliberate-crash",
        reportDirectory,
        scenario: () => {
          throw new Error("simulated driver crash");
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toBe("simulated driver crash");
      expect(result.teardown).toBe("completed");
      expect(lstat(result.sandboxRoot)).rejects.toThrow();
      expect(await Bun.file(result.reportPath).json()).toMatchObject({
        error: "simulated driver crash",
        status: "failed",
        teardown: "completed",
      });
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);

  test("parallel scenarios use distinct live sandboxes and report artifacts", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    const liveRoots: string[] = [];
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scenario = async ({ sandbox }: { sandbox: { root: string } }) => {
      liveRoots.push(sandbox.root);
      if (liveRoots.length === 2) release?.();
      await bothStarted;
      expect((await lstat(sandbox.root)).isDirectory()).toBe(true);
    };

    try {
      const results = await runScenarios({
        checkout,
        reportDirectory,
        scenarios: [
          { name: "parallel-a", scenario },
          { name: "parallel-b", scenario },
        ],
      });

      expect(results.map(({ status }) => status)).toEqual(["passed", "passed"]);
      expect(new Set(results.map(({ sandboxRoot }) => sandboxRoot)).size).toBe(2);
      expect(new Set(results.map(({ reportPath }) => reportPath)).size).toBe(2);
      for (const result of results) {
        expect(lstat(result.sandboxRoot)).rejects.toThrow();
        expect(await Bun.file(result.reportPath).exists()).toBe(true);
      }
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);
});
