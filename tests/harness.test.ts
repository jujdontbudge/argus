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
      expect(sandbox.env.XDG_DATA_HOME).toBe(join(sandbox.root, "state/data"));
      expect(sandbox.env.XDG_STATE_HOME).toBe(join(sandbox.root, "state/state"));
      expect(sandbox.env.ARGUS_REPOS_DIR).toBe(join(sandbox.root, "state/argus-repos"));
      expect(sandbox.env.CLAUDE_CONFIG_DIR).toBe(join(sandbox.root, "state/claude"));
      expect(sandbox.env.HERMES_HOME).toBe(join(sandbox.root, "state/hermes"));
      expect(sandbox.env.CMUX_SOCKET_DIR).toBe(join(sandbox.root, "state/cmux"));
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
  });

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
  });

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
        up: {
          exitCode: 1,
          stderr: "argus up: not implemented yet\n",
          stdout: "",
        },
      });
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  });
});
