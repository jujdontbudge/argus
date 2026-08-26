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

// #49 AMENDMENT — DELIBERATELY REVERSED. This test previously asserted the
// OPPOSITE: that `ARGUS_LIVE_AGENTS=1` left this gate shut, on the reasoning
// that #43's gate asks for the HERMETIC drive and must never silently spend
// Johan's own quota instead of a token provisioned for automation.
//
// That reasoning assumed a choice that does not exist. Johan's plan permits no
// API access, so no such token can ever be provisioned on this machine: the
// alternative the old pin protected is not "hermetic instead", it is "the
// Claude half does not run at all" — exactly the NOT-RUN-for-a-missing-token
// outcome SPEC §1 now forbids. Whoever opens #43's gate is asking for the live
// Claude drive, and subscription mode is what that drive IS by default.
//
// What survives from the old concern is loudness, not separation: both banners
// name the mode, so a subscription session is never started quietly. And the
// separation that actually guards the real home is untouched — it lives in the
// SPAWNER names (`createSubscriptionAgentSpawner` vs
// `createIsolatedAgentSpawner`), not in the env var. No env var reaches the
// real home; only calling that function by name does.
test("#43's gate opens this one too — a missing token is never a skip", () => {
  const gate = resolveSubscriptionGate({ ...READY, env: { ARGUS_LIVE_AGENTS: "1" } });

  expect(gate.enabled).toBe(true);
  expect(gate.claude.status).toBe("run");
  // The banner names the variable that ACTUALLY opened it. Hard-coding one of
  // the two names would tell a reader to unset something they never set.
  expect(gate.openedBy).toBe("ARGUS_LIVE_AGENTS");
  expect(describeSubscriptionGate(gate)).toStartWith("ARGUS_LIVE_AGENTS=1 —");
});

test("either gate alone opens it, and neither is required to be both", () => {
  for (const env of [
    { [LIVE_SUBSCRIPTION_GATE]: "1" },
    { ARGUS_LIVE_AGENTS: "1" },
    { ARGUS_LIVE_AGENTS: "1", [LIVE_SUBSCRIPTION_GATE]: "1" },
  ]) {
    expect({ env, enabled: resolveSubscriptionGate({ ...READY, env }).enabled })
      .toEqual({ env, enabled: true });
  }
  // …and anything other than the documented `1` still leaves it shut, so a
  // stray `ARGUS_LIVE_AGENTS=0` in a profile cannot spend a subscription.
  for (const env of [{}, { ARGUS_LIVE_AGENTS: "0" }, { [LIVE_SUBSCRIPTION_GATE]: "yes" }]) {
    expect({ env, enabled: resolveSubscriptionGate({ ...READY, env }).enabled })
      .toEqual({ env, enabled: false });
  }
  expect(resolveSubscriptionGate({ ...READY, env: {} }).openedBy).toBeNull();
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
  // SPEC §1 on the banner, because the banner is where a reader who remembers
  // the token requirement will look for it.
  expect(banner).toContain("never requires Anthropic API access");
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
