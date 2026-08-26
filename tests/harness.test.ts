import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSandbox,
  createIsolatedAgentSpawner,
  createScenarioRegistry,
  mechanicsScenario,
  runScenario,
  runScenarios,
  SimulationDriverRunner,
  type AgentSpawnRequest,
} from "../src/harness/index.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));

setDefaultTimeout(90_000);

describe("fake-Johan harness", () => {
  test("creates an isolated throwaway git repo and converges it with the real argus up", async () => {
    const sandbox = await createSandbox({ checkout });

    try {
      expect((await lstat(join(sandbox.repo, ".git"))).isDirectory()).toBe(true);
      expect(sandbox.home).toBe(join(sandbox.root, "home"));
      expect(sandbox.env.HOME).toBe(sandbox.home);
      expect(sandbox.env.XDG_CONFIG_HOME).toBe(join(sandbox.root, "state/config"));
      expect(sandbox.env.XDG_CACHE_HOME).toBe(join(sandbox.root, "state/cache"));
      expect(sandbox.env.XDG_DATA_HOME).toBe(join(sandbox.root, "state/data"));
      expect(sandbox.env.XDG_STATE_HOME).toBe(join(sandbox.root, "state/state"));
      expect(sandbox.env.ARGUS_REPOS_FILE).toBe(join(sandbox.root, "state/argus-repos"));
      expect(sandbox.env.ARGUS_SUPERVISOR_CONTROL).toBe("disabled");
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
      expect(sandbox.up.exitCode).toBe(0);
      expect(sandbox.up.stderr).toContain("TRACKER-LESS MODE");
      expect(sandbox.up.stdout).toContain(
      // #7: optional, never a convergence requirement (SPEC §3/§6).
      "cmux hooks: optional (resume convenience; not required for signal delivery)",
    );
      expect(await Bun.file(join(sandbox.repo, ".argus/config.yaml")).exists()).toBe(
        true,
      );
    } finally {
      await sandbox.teardown();
    }

    expect(lstat(sandbox.root)).rejects.toThrow();
  }, 90_000);

  test("sandbox strips ambient Claude credentials until the isolated spawner needs them", async () => {
    const names = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ] as const;
    const previous = new Map(names.map((name) => [name, Bun.env[name]]));
    for (const name of names) Bun.env[name] = `fixture-${name}`;

    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      sandbox = await createSandbox({ checkout });
      expect(names.map((name) => sandbox?.env[name])).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      if (sandbox !== undefined) await sandbox.teardown();
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete Bun.env[name];
        else Bun.env[name] = value;
      }
    }
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

  test("isolated spawner injects only the provisioned Claude OAuth token into the scratch session", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-live-spawner-"));
    const home = join(root, "home");
    const claudeConfig = join(root, "state/claude");
    const probe = join(root, "probe.ts");
    await writeFile(
      probe,
      `console.log(JSON.stringify({
        apiKey: Bun.env.ANTHROPIC_API_KEY ?? null,
        authToken: Bun.env.ANTHROPIC_AUTH_TOKEN ?? null,
        claudeConfig: Bun.env.CLAUDE_CONFIG_DIR,
        home: Bun.env.HOME,
        oauthTokenPresent: Bun.env.CLAUDE_CODE_OAUTH_TOKEN === "fixture-oauth-token",
      }));\n`,
    );
    const spawner = createIsolatedAgentSpawner({
      claudeOauthToken: "fixture-oauth-token",
      executables: { claude: process.execPath },
    });

    try {
      const result = await spawner.spawn({
        agent: "claude",
        command: ["claude", probe],
        cwd: root,
        env: {
          ANTHROPIC_API_KEY: "must-not-win-auth-precedence",
          ANTHROPIC_AUTH_TOKEN: "must-not-win-auth-precedence",
          CLAUDE_CONFIG_DIR: claudeConfig,
          HOME: home,
          PATH: process.env.PATH ?? "",
        },
        tab: "argus-test-fixture-claude",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout ?? "")).toEqual({
        apiKey: null,
        authToken: null,
        claudeConfig,
        home,
        oauthTokenPresent: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("isolated spawner refuses a Claude child pointed at the real home or config", async () => {
    const spawner = createIsolatedAgentSpawner({
      claudeOauthToken: "fixture-oauth-token",
      executables: { claude: "/must-not-run" },
    });

    expect(
      spawner.spawn({
        agent: "claude",
        command: ["claude", "-p", "must not run"],
        cwd: tmpdir(),
        env: {
          CLAUDE_CONFIG_DIR: join(homedir(), ".claude"),
          HOME: homedir(),
          PATH: process.env.PATH ?? "",
        },
        tab: "argus-test-refusal-claude",
      }),
    ).rejects.toThrow("outside the real home");
  });

  test("isolated spawner refuses a Claude child when no token is provisioned", async () => {
    const spawner = createIsolatedAgentSpawner({
      executables: { claude: "/must-not-run" },
    });
    const scratch = await mkdtemp(join(tmpdir(), "argus-live-untokened-"));

    try {
      expect(
        spawner.spawn({
          agent: "claude",
          command: ["claude", "-p", "must not run"],
          cwd: scratch,
          env: {
            CLAUDE_CONFIG_DIR: join(scratch, "state/claude"),
            HOME: join(scratch, "home"),
            PATH: process.env.PATH ?? "",
          },
          tab: "argus-test-untokened-claude",
        }),
      ).rejects.toThrow("live Claude drive needs a provisioned CLAUDE_CODE_OAUTH_TOKEN");
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  });

  test("the real-home refusal still outranks the missing token", async () => {
    // #41's refusal is the safety property and must be the FIRST thing that
    // fails, so a caller who is both untokened and pointed at the real home is
    // told about the home. Provisioning a token must never be the way to make
    // this message go away.
    const spawner = createIsolatedAgentSpawner({
      executables: { claude: "/must-not-run" },
    });

    expect(
      spawner.spawn({
        agent: "claude",
        command: ["claude", "-p", "must not run"],
        cwd: tmpdir(),
        env: {
          CLAUDE_CONFIG_DIR: join(homedir(), ".claude"),
          HOME: homedir(),
          PATH: process.env.PATH ?? "",
        },
        tab: "argus-test-untokened-refusal-claude",
      }),
    ).rejects.toThrow("outside the real home");
  });

  test("a Codex child needs no Claude token and keeps its scratch CODEX_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-live-codex-seam-"));
    const codexHome = join(root, "state/codex");
    const probe = join(root, "probe.ts");
    await writeFile(
      probe,
      `console.log(JSON.stringify({ codexHome: Bun.env.CODEX_HOME }));\n`,
    );
    const spawner = createIsolatedAgentSpawner({
      executables: { codex: process.execPath },
    });

    try {
      const result = await spawner.spawn({
        agent: "codex",
        command: ["codex", probe],
        cwd: root,
        env: { CODEX_HOME: codexHome, PATH: process.env.PATH ?? "" },
        tab: "argus-test-fixture-codex",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout ?? "")).toEqual({ codexHome });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("registry exposes all ten core scenario slots and accepts future implementations", () => {
    const registry = createScenarioRegistry();

    expect(registry.list()).toEqual([
      { number: 1, status: "unimplemented", title: "Autonomous batch, zero human input" },
      { number: 2, status: "implemented", title: "Fake-Johan takeover" },
      { number: 3, status: "unimplemented", title: "Rogue session" },
      { number: 4, status: "unimplemented", title: "The poisoning test" },
      { number: 5, status: "unimplemented", title: "Fault injection: the unlogged send" },
      { number: 6, status: "implemented", title: "Watcher death" },
      { number: 7, status: "unimplemented", title: "Signal paths" },
      { number: 8, status: "unimplemented", title: "Self-learning loop" },
      { number: 9, status: "implemented", title: "Semantic isolation" },
      { number: 10, status: "implemented", title: "Blast-radius zero" },
    ]);

    registry.register(3, async () => {});

    expect(registry.list()[2]).toEqual({
      number: 3,
      status: "implemented",
      title: "Rogue session",
    });
    expect(registry.get(3)).toBeFunction();
    expect(registry.get(2)).toBeFunction();
    expect(registry.get(9)).toBeFunction();
    expect(registry.get(10)).toBeFunction();
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
        // #63: a scenario that spawned no agent has no live evidence, so its
        // verdict is STRUCTURAL. The report carries both, and the artifact is
        // where a reader who never saw the suite output finds them.
        liveEvidence: [],
        name: "mechanics-isolation",
        sandboxRoot: result.sandboxRoot,
        status: "passed",
        teardown: "completed",
        up: result.up,
        verdict: "STRUCTURAL",
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

  // #76: the peer's own eyes now RUN across the wipe. The old expectation —
  // five assertions over a dormant peer directory — was the shape of the
  // overclaim: byte-identity is trivially true when nothing is watching.
  test("scenario 10 wipes one converged repo without a RUNNING peer instance noticing", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    const scenario = createScenarioRegistry().get(10);

    try {
      expect(scenario).toBeFunction();
      const result = await runScenario({
        checkout,
        name: "blast-radius-zero",
        reportDirectory,
        scenario: scenario!,
      });

      expect(result.status).toBe("passed");
      expect(result.assertions).toEqual([
        { description: "primary sandbox was converged by argus up", passed: true },
        { description: "peer sandbox was converged by argus up", passed: true },
        {
          description: "the peer repo's five real eyes were running before the wipe",
          passed: true,
        },
        { description: "primary .argus state was removed", passed: true },
        {
          description:
            "peer .argus state stayed byte-identical while its own eyes were running",
          passed: true,
        },
        { description: "peer supervisor state stayed byte-identical", passed: true },
        {
          description: "the peer archive gained and lost nothing across the wipe",
          passed: true,
        },
        {
          description:
            "every peer eye kept its pid across the wipe — none died or restarted",
          passed: true,
        },
        {
          description: "no peer eye recorded a new error across the wipe",
          passed: true,
        },
        {
          description:
            "every peer eye's heartbeat advanced past the wipe — awake, not merely alive",
          passed: true,
        },
        {
          description:
            "the peer instance archived a message written after the primary wipe",
          passed: true,
        },
        {
          description:
            "every peer eye this scenario started was stopped at teardown",
          passed: true,
        },
      ]);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);

  test("scenario 2 logs a Fake-Johan observation against the user peer", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    const scenario = createScenarioRegistry().get(2);

    try {
      expect(scenario).toBeFunction();
      const result = await runScenario({
        checkout,
        name: "fake-johan-binding",
        reportDirectory,
        scenario: scenario!,
      });

      expect(result.status).toBe("passed");
      expect(result.assertions).toEqual([
        { description: "sandbox was converged by argus up", passed: true },
        { description: "Johan is the observable Honcho peer", passed: true },
        { description: "user-peer observation was logged", passed: true },
      ]);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);

  test("scenario 9 keeps two repos' Honcho and Hermes semantics isolated", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    const scenario = createScenarioRegistry().get(9);

    try {
      expect(scenario).toBeFunction();
      const result = await runScenario({
        checkout,
        name: "semantic-isolation",
        reportDirectory,
        scenario: scenario!,
      });

      expect(result.status).toBe("passed");
      expect(result.assertions).toEqual([
        { description: "primary sandbox was converged by argus up", passed: true },
        { description: "peer sandbox was converged by argus up", passed: true },
        { description: "repos bind separate Honcho workspaces", passed: true },
        { description: "repos bind separate Hermes profiles", passed: true },
        { description: "Hermes memories resolve only inside each repo", passed: true },
        { description: "primary Johan reads exclude agent and peer-repo observations", passed: true },
        { description: "peer Johan reads exclude primary-repo observations", passed: true },
      ]);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);

});
