import { describe, expect, test } from "bun:test";

import {
  CLAUDE_ROUTE,
  CODEX_ROUTE,
  STRIPPED_ENV,
  subscriptionEnv,
} from "./index.ts";

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
