import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { liveHalfTitle } from "./live-gate.ts";
import {
  describeSubscriptionGate,
  LIVE_SUBSCRIPTION_GATE,
  NATIVE_CLAUDE,
  probeSubscriptionMode,
  resolveSubscriptionGate,
  type SubscriptionProbe,
} from "./subscription-gate.ts";

const READY: SubscriptionProbe = {
  claudeProjectsRoot: join(homedir(), ".claude/projects"),
  env: { [LIVE_SUBSCRIPTION_GATE]: "1" },
  nativeClaudeInstalled: true,
  projectsRootExists: true,
};

test("the gate is shut by default and says why in #43's vocabulary", () => {
  const gate = resolveSubscriptionGate({ ...READY, env: {} });

  expect(LIVE_SUBSCRIPTION_GATE).toBe("ARGUS_LIVE_CLAUDE_SUBSCRIPTION");
  expect(gate.enabled).toBe(false);
  expect(gate.claude.status).toBe("gate-unset");
  expect(gate.claude.reason).toContain(LIVE_SUBSCRIPTION_GATE);
  expect(liveHalfTitle("x", gate.claude)).toStartWith("x — SKIPPED: ");
});

test("#43's gate does NOT open this one — the two modes are separate choices", () => {
  // The load-bearing assertion of the whole ticket. ARGUS_LIVE_AGENTS=1 asks
  // for the HERMETIC drive, which burns a provisioned token. It must never
  // silently start a session under Johan's real identity and quota instead.
  const gate = resolveSubscriptionGate({ ...READY, env: { ARGUS_LIVE_AGENTS: "1" } });

  expect(gate.enabled).toBe(false);
  expect(gate.claude.status).toBe("gate-unset");
});

test("asked for, but unprovisioned, is NOT RUN — never a quiet pass", () => {
  const noCli = resolveSubscriptionGate({ ...READY, nativeClaudeInstalled: false });
  expect(noCli.claude.status).toBe("not-run");
  expect(noCli.claude.reason).toBe(`the native claude CLI is not at ${NATIVE_CLAUDE}`);
  expect(liveHalfTitle("x", noCli.claude)).toStartWith("x — NOT RUN: ");

  const noProjects = resolveSubscriptionGate({ ...READY, projectsRootExists: false });
  expect(noProjects.claude.status).toBe("not-run");
  expect(noProjects.claude.reason).toContain("no subscription session history");
});

test("fully provisioned runs, and the banner never implies a token", () => {
  const gate = resolveSubscriptionGate(READY);

  expect(gate.claude.status).toBe("run");
  expect(liveHalfTitle("§13 subscription drive", gate.claude)).toBe(
    "§13 subscription drive",
  );
  const banner = describeSubscriptionGate(gate);
  expect(banner).toContain("RUN");
  expect(banner).toContain("no token");
  expect(banner).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("the probe reads this machine without opening a credential", () => {
  const probe = probeSubscriptionMode();

  expect(probe.claudeProjectsRoot).toBe(join(homedir(), ".claude/projects"));
  // Presence only, all of it. Nothing here reads `.credentials.json`, and the
  // real config is never written — this mode's whole claim is that it uses
  // the SAME path Johan's live sessions already refresh on, not a copy.
  expect(typeof probe.nativeClaudeInstalled).toBe("boolean");
  expect(typeof probe.projectsRootExists).toBe("boolean");
});
