import { describe, expect, test } from "bun:test";

import {
  describeLiveAgentGate,
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
      reason: "gate set and CLAUDE_CODE_OAUTH_TOKEN is provisioned",
      status: "run",
    });
  });

  test("holds Claude NOT RUN without a token while Codex still runs", () => {
    const gate = resolveLiveAgentGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1" },
    });

    expect(gate.claude.status).toBe("not-run");
    expect(gate.claude.reason).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN is not provisioned — generate one out of band",
    );
    expect(gate.codex.status).toBe("run");
  });

  test("treats an empty token as not provisioned rather than as a credential", () => {
    expect(
      resolveLiveAgentGate({
        claudeInstalled: true,
        codexAuthPresent: true,
        codexInstalled: true,
        env: { ARGUS_LIVE_AGENTS: "1", CLAUDE_CODE_OAUTH_TOKEN: "" },
      }).claude.status,
    ).toBe("not-run");
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
    expect(liveHalfTitle("§13 live Claude drive", asked.claude)).toBe(
      "§13 live Claude drive — NOT RUN: CLAUDE_CODE_OAUTH_TOKEN is not provisioned — generate one out of band",
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

    expect(banner.split("\n")).toEqual([
      "ARGUS_LIVE_AGENTS=1 — live agent drives are ENABLED (this burns a subscription)",
      "  claude  NOT RUN  CLAUDE_CODE_OAUTH_TOKEN is not provisioned — generate one out of band",
      "  codex   RUN      gate set and the codex CLI and auth.json are both present",
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