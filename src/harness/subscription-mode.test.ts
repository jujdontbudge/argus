import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createIsolatedAgentSpawner } from "./index.ts";
import { SandboxScope } from "./sandbox-scope.ts";
import { createSubscriptionAgentSpawner } from "./subscription-mode.ts";

/**
 * Ticket #49. These pin the DIFFERENCE between the two modes, which is the
 * whole point of them being two entry points: #41's hermetic spawner refuses
 * the real home, and this one requires it.
 */
test("the subscription spawner runs under the real home with no token anywhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-subscription-"));
  const probe = join(root, "probe.ts");
  await writeFile(
    probe,
    `console.log(JSON.stringify({
      apiKey: Bun.env.ANTHROPIC_API_KEY ?? null,
      authToken: Bun.env.ANTHROPIC_AUTH_TOKEN ?? null,
      claudeConfig: Bun.env.CLAUDE_CONFIG_DIR ?? null,
      home: Bun.env.HOME,
      oauthToken: Bun.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    }));\n`,
  );

  const result = await createSubscriptionAgentSpawner({
    executables: { claude: process.execPath },
    scope: new SandboxScope(root),
  }).spawn({
    agent: "claude",
    command: ["claude", probe],
    cwd: root,
    // Everything a hermetic sandbox would have handed the child. Subscription
    // mode has to strip all of it: a scratch CLAUDE_CONFIG_DIR is exactly the
    // credential-free config that made a token mandatory in the first place.
    env: {
      ANTHROPIC_API_KEY: "must-not-reach-the-child",
      ANTHROPIC_AUTH_TOKEN: "must-not-reach-the-child",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-the-child",
      CLAUDE_CONFIG_DIR: join(root, "state/claude"),
      HOME: join(root, "home"),
      PATH: process.env.PATH ?? "",
    },
    tab: "argus-test-subscription-claude",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout ?? "")).toEqual({
    apiKey: null,
    authToken: null,
    claudeConfig: null,
    home: homedir(),
    oauthToken: null,
  });
});

test("the subscription spawner refuses a cwd outside the sandbox, before any process", async () => {
  const scope = new SandboxScope(await mkdtemp(join(tmpdir(), "argus-subscription-")));
  const spawner = createSubscriptionAgentSpawner({
    executables: { claude: "/must-not-run" },
    scope,
  });
  const env = { HOME: homedir(), PATH: process.env.PATH ?? "" };

  // Real HOME is what this mode is FOR, so it cannot also be the guard. The
  // guard is the cwd, and these are the three places §13 names by name.
  for (const cwd of [join(homedir(), "argus"), homedir(), "/"]) {
    expect(
      spawner.spawn({
        agent: "claude",
        command: ["claude", "-p", "must not run"],
        cwd,
        env,
        tab: "argus-test-subscription-refusal",
      }),
    ).rejects.toThrow("sandbox scope refused subscription spawn cwd");
  }
  expect(scope.adopted.size).toBe(0);
});

test("subscription mode drives Claude only — Codex keeps its own isolated path", async () => {
  const scope = new SandboxScope(await mkdtemp(join(tmpdir(), "argus-subscription-")));

  expect(
    createSubscriptionAgentSpawner({ scope }).spawn({
      agent: "codex",
      command: ["codex", "must not run"],
      cwd: scope.root,
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
      tab: "argus-test-subscription-codex",
    }),
  ).rejects.toThrow("subscription mode drives Claude only");
});

test("#41's refusals and #43's ordering are untouched by the second mode", async () => {
  const hermetic = createIsolatedAgentSpawner({ executables: { claude: "/must-not-run" } });
  const scratch = await mkdtemp(join(tmpdir(), "argus-hermetic-"));

  // #41: a hermetic drive pointed at the real home is still refused, so
  // pointing one there by omission remains impossible.
  expect(
    hermetic.spawn({
      agent: "claude",
      command: ["claude", "-p", "must not run"],
      cwd: tmpdir(),
      env: {
        CLAUDE_CONFIG_DIR: join(homedir(), ".claude"),
        HOME: homedir(),
        PATH: process.env.PATH ?? "",
      },
      tab: "argus-test-hermetic-refusal",
    }),
  ).rejects.toThrow("isolated Claude HOME and CLAUDE_CONFIG_DIR must be outside the real home");

  // #43: the ISOLATION refusal outranks the untokened one. A caller who is
  // both untokened AND pointed at the real home must be told about the home —
  // subscription mode must not become the answer to a token error either.
  expect(
    hermetic.spawn({
      agent: "claude",
      command: ["claude", "-p", "must not run"],
      cwd: tmpdir(),
      env: {
        CLAUDE_CONFIG_DIR: join(homedir(), ".claude"),
        HOME: homedir(),
        PATH: process.env.PATH ?? "",
      },
      tab: "argus-test-hermetic-ordering",
    }),
  ).rejects.toThrow("outside the real home");

  // …and untokened-but-isolated still fails on the token, not the home.
  expect(
    hermetic.spawn({
      agent: "claude",
      command: ["claude", "-p", "must not run"],
      cwd: scratch,
      env: {
        CLAUDE_CONFIG_DIR: join(scratch, "state/claude"),
        HOME: join(scratch, "home"),
        PATH: process.env.PATH ?? "",
      },
      tab: "argus-test-hermetic-untokened",
    }),
  ).rejects.toThrow("a live Claude drive needs a provisioned CLAUDE_CODE_OAUTH_TOKEN");
});
