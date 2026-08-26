import { describe, expect, test } from "bun:test";

import {
  describeLiveAgentGate,
  hermeticClaudeHalf,
  liveHalfTitle,
  LIVE_AGENT_GATE,
  probeLiveAgents,
  resolveLiveAgentGate,
  type LiveAgentProbe,
} from "./live-gate.ts";

describe("the live-agent gate", () => {
  test("is closed when the opt-in variable is unset, for both agents", () => {
    const gate = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "provisioned" },
    });

    expect(LIVE_AGENT_GATE).toBe("ARGUS_LIVE_AGENTS");
    expect(gate.enabled).toBe(false);
    expect(gate.codex.status).toBe("gate-unset");
    expect(gate.claude.status).toBe("gate-unset");
    expect(gate.codex.reason).toContain("ARGUS_LIVE_AGENTS");
    expect(gate.claude.reason).toContain("ARGUS_LIVE_AGENTS");
    // The mode is resolved even with the gate shut, so a reader can see which
    // path WOULD run without opening the gate to find out.
    expect(gate.claude.mode).toBe("hermetic");
  });

  test("opens both halves when the gate is set and every credential is provisioned", () => {
    const gate = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: {
        ARGUS_LIVE_AGENTS: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "provisioned",
      },
    });

    expect(gate.enabled).toBe(true);
    expect(gate.codex).toEqual({
      agent: "codex",
      reason: "gate set and the codex CLI and auth.json are both present",
      status: "run",
    });
    expect(gate.claude).toEqual({
      agent: "claude",
      mode: "hermetic",
      reason:
        "gate set and CLAUDE_CODE_OAUTH_TOKEN is provisioned — hermetic mode",
      status: "run",
    });
  });

  // #49 AMENDMENT. This test previously pinned the OPPOSITE — `not-run` with
  // the reason "CLAUDE_CODE_OAUTH_TOKEN is not provisioned — generate one out
  // of band". That string encoded a requirement Johan has since ruled out:
  // his Claude plan does not permit API access, so "generate one out of band"
  // is not advice he can take, and a half that reports NOT RUN for want of it
  // never runs at all. SPEC §1 now forbids requiring Anthropic API access, so
  // an absent token selects the OTHER mode rather than blocking the half.
  test("falls back to subscription mode without a token — never NOT RUN", () => {
    const gate = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1" },
    });

    expect(gate.claude.status).toBe("run");
    expect(gate.claude.mode).toBe("subscription");
    expect(gate.claude.reason).toBe(
      "gate set and no token is needed — the Claude half runs in subscription mode",
    );
    expect(gate.codex.status).toBe("run");
  });

  test("treats an empty token exactly as an absent one — subscription mode", () => {
    const empty = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1", CLAUDE_CODE_OAUTH_TOKEN: "" },
    }).claude;

    expect(empty.status).toBe("run");
    expect(empty.mode).toBe("subscription");
  });

  // The amendment's acceptance criterion, asserted exhaustively rather than by
  // example: across every token shape a machine can present, the ONLY thing
  // that can hold the Claude half back is a missing CLI.
  test("no absent-token state can produce not-run for the Claude half", () => {
    const tokens: Array<string | undefined> = [
      undefined,
      "",
      " ",
      "provisioned",
    ];

    for (const token of tokens) {
      for (const claudeInstalled of [true, false]) {
        const { claude } = resolveLiveAgentGate({
          claudeInstalled,
          codexAuthPresent: true,
          codexInstalled: true,
          env: {
            ARGUS_LIVE_AGENTS: "1",
            ...(token !== undefined && { CLAUDE_CODE_OAUTH_TOKEN: token }),
          },
        });

        expect({ status: claude.status, token, claudeInstalled }).toEqual({
          status: claudeInstalled ? "run" : "not-run",
          token,
          claudeInstalled,
        });
        // …and when it IS not-run, the reason is the CLI, never the token.
        if (claude.status === "not-run") {
          expect(claude.reason).toBe("the claude CLI is not on PATH");
        }
      }
    }
  });

  // The stricter mode is still reachable, and still opt-in by having a token.
  // It is SKIPPED, not NOT RUN, when unselected: nobody asked for it, and the
  // Claude half is running elsewhere, so nothing is unverified because of it.
  test("the optional hermetic drive is SKIPPED, not NOT RUN, when unselected", () => {
    const untokened = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1" },
    });
    const tokened = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1", CLAUDE_CODE_OAUTH_TOKEN: "provisioned" },
    });
    const shut = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: {},
    });

    expect(hermeticClaudeHalf(untokened)).toEqual({
      reason:
        "no CLAUDE_CODE_OAUTH_TOKEN — the optional hermetic mode is not selected; the Claude half runs in subscription mode",
      status: "gate-unset",
    });
    expect(liveHalfTitle("x", hermeticClaudeHalf(untokened))).toStartWith(
      "x — SKIPPED: ",
    );
    // Tokened: the strict drive is exactly the gate's own claude verdict.
    expect(hermeticClaudeHalf(tokened)).toBe(tokened.claude);
    // Gate shut outranks mode — the reason a reader needs first is the gate.
    expect(hermeticClaudeHalf(shut)).toBe(shut.claude);
  });

  test("names the missing CLI or credential per agent, one reason at a time", () => {
    const missing = (probe: Partial<LiveAgentProbe>) =>
      resolveLiveAgentGate({
        claudeInstalled: true,
        codexAuthPresent: true,
        codexInstalled: true,
        env: { ARGUS_LIVE_AGENTS: "1", CLAUDE_CODE_OAUTH_TOKEN: "provisioned" },
        ...probe,
      });

    expect(missing({ codexInstalled: false }).codex).toEqual({
      agent: "codex",
      reason: "the codex CLI is not on PATH",
      status: "not-run",
    });
    expect(missing({ codexAuthPresent: false }).codex).toEqual({
      agent: "codex",
      reason: "~/.codex/auth.json is not present",
      status: "not-run",
    });
    expect(missing({ claudeInstalled: false }).claude).toEqual({
      agent: "claude",
      mode: "hermetic",
      reason: "the claude CLI is not on PATH",
      status: "not-run",
    });
    // A missing CLI is reported before a missing credential: it is the one a
    // reader can act on without touching secrets.
    expect(
      missing({ claudeInstalled: false, env: { ARGUS_LIVE_AGENTS: "1" } }).claude
        .reason,
    ).toBe("the claude CLI is not on PATH");
  });

  test("carries the reason into the test NAME, so a skip is never silent", () => {
    const shut = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: {},
    });
    const asked = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1" },
    });

    expect(liveHalfTitle("§13 live Codex drive", shut.codex)).toBe(
      "§13 live Codex drive — SKIPPED: ARGUS_LIVE_AGENTS is unset — the default gate never burns a subscription",
    );
    // #49: an untokened Claude half is titled by what it proves, because it
    // RUNS — in subscription mode. The old expectation here was the NOT RUN
    // title, which is precisely the outcome the amendment forbids.
    expect(liveHalfTitle("§13 live Claude drive", asked.claude)).toBe(
      "§13 live Claude drive",
    );
    // A half that actually runs is titled by what it proves, not by the gate.
    expect(liveHalfTitle("§13 live Codex drive", asked.codex)).toBe(
      "§13 live Codex drive",
    );
  });

  test("summarises every half in one banner for whoever opened the gate", () => {
    const banner = describeLiveAgentGate(
      resolveLiveAgentGate({
        claudeInstalled: true,
        codexAuthPresent: true,
        codexInstalled: true,
        env: { ARGUS_LIVE_AGENTS: "1" },
      }),
    );

    // #49: the untokened line changed from NOT RUN to RUN, and gained the
    // constraint that made it change, so whoever opened the gate reads WHY
    // no token is being asked for rather than assuming one went missing.
    expect(banner.split("\n")).toEqual([
      "ARGUS_LIVE_AGENTS=1 — live agent drives are ENABLED (this burns a subscription)",
      "  claude  RUN      gate set and no token is needed — the Claude half runs in subscription mode",
      "  codex   RUN      gate set and the codex CLI and auth.json are both present",
      "  SPEC §1: Argus never requires Anthropic API access — real HOME, sandbox cwd, scripted scope",
    ]);
  });

  test("says so plainly when the gate is open but no half can run", () => {
    expect(
      describeLiveAgentGate(
        resolveLiveAgentGate({
          claudeInstalled: false,
          codexAuthPresent: false,
          codexInstalled: false,
          env: { ARGUS_LIVE_AGENTS: "1" },
        }),
      ),
    ).toContain("NO live half can run on this machine");
  });

  test("never repeats the token itself, in any reason, title or banner", () => {
    const secret = "sk-ant-oat-do-not-print-me";
    const gate = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1", CLAUDE_CODE_OAUTH_TOKEN: secret },
    });
    const surfaces = [
      describeLiveAgentGate(gate),
      liveHalfTitle("§13 live Claude drive", gate.claude),
      JSON.stringify(gate),
    ];

    expect(gate.claude.status).toBe("run");
    for (const surface of surfaces) expect(surface).not.toContain(secret);
  });

  test("probes the real shell variable, so setting it in a shell opens the gate", () => {
    const previous = Bun.env[LIVE_AGENT_GATE];

    try {
      delete Bun.env[LIVE_AGENT_GATE];
      expect(resolveLiveAgentGate(probeLiveAgents()).enabled).toBe(false);

      Bun.env[LIVE_AGENT_GATE] = "1";
      expect(resolveLiveAgentGate(probeLiveAgents()).enabled).toBe(true);

      // Anything other than the documented `1` leaves the gate shut, so a
      // stray `ARGUS_LIVE_AGENTS=0` in a profile cannot spend a subscription.
      Bun.env[LIVE_AGENT_GATE] = "0";
      expect(resolveLiveAgentGate(probeLiveAgents()).enabled).toBe(false);
    } finally {
      if (previous === undefined) delete Bun.env[LIVE_AGENT_GATE];
      else Bun.env[LIVE_AGENT_GATE] = previous;
    }
  });

  test("collapses to ONE line when shut — bun prints no name for a skip", () => {
    const banner = describeLiveAgentGate(
      resolveLiveAgentGate({
        claudeInstalled: true,
        codexAuthPresent: true,
        codexInstalled: true,
        env: {},
      }),
    );

    expect(banner.split("\n")).toEqual([
      "argus: live agent drives SKIPPED (claude, codex) — set ARGUS_LIVE_AGENTS=1 to run them; they burn a subscription",
    ]);
  });
});