import { describe, expect, test } from "bun:test";

import {
  CLAUDE_ROUTE,
  CODEX_ROUTE,
  CODEX_SANDBOX_POSTURE,
  STRIPPED_ENV,
  subscriptionEnv,
} from "./index.ts";
import { CLAUDE_GRILL_ROUTE } from "../grill/route.ts";

/**
 * Ticket #55 — routing, and the two CLI facts the ordering promise rests on.
 *
 * The codex line below is not invented: it is the literal first stdout line
 * from a real `codex exec --json` run on this machine (codex-cli 0.149.1) with
 * a scratch `CODEX_HOME` and no auth, so it reached a 401 without spending
 * anything. If a future codex changes that shape, the announced route stops
 * finding a session id — and `deployWorker` fails closed rather than
 * registering a guess, which is why this pin matters.
 */
describe("routes (#55): who names the session", () => {
  test("claude takes the id Argus chose, before the process exists", () => {
    const command = CLAUDE_ROUTE.command({
      dispatchPrompt: "ticket #55",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(CLAUDE_ROUTE.sessionIdMode).toBe("preassigned");
    expect(command).toEqual([
      "claude",
      "--session-id",
      "11111111-2222-4333-8444-555555555555",
      "--model",
      "claude-opus-5",
      // #88: a deployed worker runs at Johan's standing directive — Opus at
      // max effort — and the flag is pinned here so a route that quietly
      // dropped it fails a test instead of a ticket.
      "--effort",
      "max",
      "-p",
      "ticket #55",
    ]);
    // SPEC §1 item 7: subscription mode. No `--api-key`, no token argument.
    expect(command.join(" ")).not.toContain("api");
  });

  test("the grill route defaults to Fable and accepts a launch override", () => {
    const defaults = CLAUDE_GRILL_ROUTE.command({ dispatchPrompt: "grill" });
    expect(defaults).toContain("claude-fable-5");

    const overridden = CLAUDE_GRILL_ROUTE.command({
      dispatchPrompt: "grill",
      model: "claude-opus-5",
    });
    expect(overridden).toContain("claude-opus-5");
    expect(overridden).not.toContain("claude-fable-5");
  });

  test("codex announces its own id on stdout, and only `thread.started` counts", () => {
    expect(CODEX_ROUTE.sessionIdMode).toBe("announced");
    expect(
      CODEX_ROUTE.announce?.(
        '{"type":"thread.started","thread_id":"01a03c64-8acb-7c40-9cf5-68ddcac45e56"}',
      ),
    ).toBe("01a03c64-8acb-7c40-9cf5-68ddcac45e56");
    expect(CODEX_ROUTE.announce?.('{"type":"turn.started"}')).toBeNull();
    expect(CODEX_ROUTE.announce?.("not json at all")).toBeNull();
    expect(CODEX_ROUTE.announce?.('{"type":"thread.started"}')).toBeNull();
    expect(CODEX_ROUTE.command({ dispatchPrompt: "ticket #55" })).toEqual([
      "codex",
      "exec",
      "--json",
      // #88 made codex the DEFAULT implementer (SPEC §2), so the effort it
      // implements at stopped being hypothetical: SPEC §2 puts codex on
      // "high reasoning effort" by name, and this is where that becomes argv.
      "-c",
      "model_reasoning_effort=high",
      // #104: the sandbox posture, in argv, because inheriting it is the bug.
      ...CODEX_SANDBOX_POSTURE,
      "ticket #55",
    ]);
  });
});

describe("subscriptionEnv (#55): SPEC §1 item 7, enforced on the child", () => {
  test("API credentials are stripped, everything else is inherited", () => {
    const env = subscriptionEnv({
      ANTHROPIC_API_KEY: "sk-should-never-reach-a-worker",
      ANTHROPIC_AUTH_TOKEN: "also-never",
      CLAUDE_CODE_OAUTH_TOKEN: "nor-this",
      HOME: "/Users/someone",
      PATH: "/usr/bin",
      UNSET: undefined,
    });
    expect(env).toEqual({ HOME: "/Users/someone", PATH: "/usr/bin" });
    for (const name of STRIPPED_ENV) expect(env[name]).toBeUndefined();
  });
});

/**
 * Ticket #104 finding 1 — the deployed Codex worker's sandbox posture.
 *
 * THE ORDERING OF THESE TWO TESTS IS THE POINT, and it follows #102's shape.
 * The weak one below passes on the broken code. It is the test a "does a
 * deployed worker work?" instinct writes, and it is exactly how this bug
 * survived two drives: on Johan's machine `~/.codex/config.toml` says
 * `sandbox_mode = "danger-full-access"`, so a worker writes happily whether or
 * not Argus asked for anything. A test that observes a successful write here
 * observes Johan's personal config, not Argus's behaviour.
 *
 * The strong one asserts the posture is SET BY ARGUS — present in argv, so it
 * holds on a machine whose config says nothing, which is the machine `argus
 * init`/`argus up` actually targets. It fails on the pre-#104 route.
 */
describe("#104 finding 1: a deployed codex worker's posture is Argus's, not the machine's", () => {
  const argv = CODEX_ROUTE.command({ dispatchPrompt: "ticket #104" });

  test("WEAK, and passes on the broken code: it is a codex exec dispatch", () => {
    // Everything this checks was already true when every deployed worker was
    // read-only. Kept deliberately, and named, so the next reader can see that
    // this class of assertion is what let #82 finding 1 survive into #99.
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(argv.at(-1)).toBe("ticket #104");
  });

  test("STRONG: write access is granted by argv, so it survives an empty config", () => {
    // Literal strings, not the exported constant: asserting `argv` contains
    // `...CODEX_SANDBOX_POSTURE` would pass if that constant were emptied,
    // which is the regression being guarded against.
    const overrides = argv.flatMap((arg, index) =>
      arg === "-c" && argv[index + 1] !== undefined ? [argv[index + 1] as string] : [],
    );
    expect(overrides).toContain("sandbox_mode=workspace-write");

    // What is deliberately NOT granted. A worker is told "do not merge, do not
    // push, and do not close the ticket", and `bun install --frozen-lockfile`
    // has already run in the worktree before it spawns, so it has no call to
    // make off this machine — and it never gets Johan's attended-session
    // posture.
    expect(overrides).toContain("sandbox_workspace_write.network_access=false");
    expect(overrides).toContain("approval_policy=never");
    expect(argv.join(" ")).not.toContain("danger-full-access");

    // The class, not the spelling: no posture key Argus depends on may be left
    // to the config file. Every one of them is an explicit `-c` override.
    for (const key of [
      "sandbox_mode",
      "sandbox_workspace_write.network_access",
      "approval_policy",
    ]) {
      expect(overrides.some((o) => o.startsWith(`${key}=`))).toBe(true);
    }
  });
});
