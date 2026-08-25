import { describe, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSandbox,
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
});
