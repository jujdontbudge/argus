/**
 * Ticket #49 — the gate for the subscription-mode Opus drive.
 *
 * #43 split `gate-unset` from `not-run` because collapsing them is how a half
 * quietly passes, and #47 reused that split rather than growing a second
 * vocabulary for the same three statuses. This module does the same: same
 * `LiveHalfStatus`, same `liveHalfTitle`, same banner words.
 *
 * It is a SEPARATE gate from `ARGUS_LIVE_AGENTS` on purpose, and that is the
 * ticket's central safety claim rather than a naming preference. The two
 * modes cost different things: the hermetic drive spends a token provisioned
 * for automation, and this one spends Johan's own subscription under his own
 * identity, in his own session list. Opening one must never open the other,
 * so `ARGUS_LIVE_AGENTS=1` leaves this gate shut and vice versa. The modes
 * differ by deliberate choice, never by a forgotten argument.
 *
 * Pure by construction like both predecessors: every input arrives in the
 * probe, so all states are testable without touching the real environment.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LIVE_HALF_BANNER, type LiveHalfOutcome, type LiveHalfStatus } from "./live-gate.ts";

/** Opt in with `ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1`. Never implied by #43's gate. */
export const LIVE_SUBSCRIPTION_GATE = "ARGUS_LIVE_CLAUDE_SUBSCRIPTION";

/**
 * The native install, not `Bun.which("claude")`.
 *
 * #41 hit this and recorded it: the first `claude` on PATH here is a wrapper
 * (cmux's, and a `~/.bun/bin` one, and a shell function pointing at the
 * `claude-api1` launcher that #36 measured hanging without an assistant
 * turn). A drive that resolves by PATH is a drive that may not be running
 * Claude Code at all, so the gate asks for the real binary by name.
 */
export const NATIVE_CLAUDE = join(homedir(), ".local/bin/claude");

export interface SubscriptionProbe {
  /** Where a subscription session's transcript lands, by slug. */
  claudeProjectsRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  nativeClaudeInstalled: boolean;
  projectsRootExists: boolean;
}

export interface SubscriptionGate {
  claude: LiveHalfOutcome;
  enabled: boolean;
}

const GATE_SHUT =
  `${LIVE_SUBSCRIPTION_GATE} is unset — the default gate never spends Johan's subscription`;

export function resolveSubscriptionGate(probe: SubscriptionProbe): SubscriptionGate {
  const enabled = probe.env[LIVE_SUBSCRIPTION_GATE] === "1";
  return { claude: half(enabled, probe), enabled };
}

function half(enabled: boolean, probe: SubscriptionProbe): LiveHalfOutcome {
  if (!enabled) return { reason: GATE_SHUT, status: "gate-unset" };
  const missing = missingForSubscription(probe);
  if (missing !== null) return { reason: missing, status: "not-run" };
  return {
    reason: "gate set, the native claude CLI is present and no token is needed",
    status: "run",
  };
}

function missingForSubscription(probe: SubscriptionProbe): string | null {
  if (!probe.nativeClaudeInstalled) {
    return `the native claude CLI is not at ${NATIVE_CLAUDE}`;
  }
  // Presence of the projects root, and nothing else. It is the directory a
  // subscription session writes its transcript into; its ABSENCE means this
  // machine has never run one, which is a real "not run", not a failure.
  if (!probe.projectsRootExists) {
    return `${probe.claudeProjectsRoot} does not exist — no subscription session history on this machine`;
  }
  return null;
}

/** The line the suite prints, whatever the gate says — #43's words exactly. */
export function describeSubscriptionGate(gate: SubscriptionGate): string {
  const banner: Readonly<Record<LiveHalfStatus, string>> = LIVE_HALF_BANNER;
  if (!gate.enabled) {
    return `argus: subscription-mode Claude drive SKIPPED — set ${LIVE_SUBSCRIPTION_GATE}=1 to run it; it spends Johan's own subscription (no token)`;
  }
  return [
    `${LIVE_SUBSCRIPTION_GATE}=1 — the subscription-mode Claude drive is ENABLED`,
    `  claude  ${banner[gate.claude.status]}  ${gate.claude.reason}`,
    "  real HOME, sandbox cwd, no token: the blast radius here is scripted scope, not an OS boundary",
  ].join("\n");
}

/**
 * This machine, right now. The only function here that reads the world.
 *
 * Presence tests exclusively. `~/.claude/.credentials.json` is never read,
 * copied or even stat-ed: subscription mode's entire claim is that it uses
 * the same config path Johan's live sessions already refresh on, so there is
 * nothing to copy and nothing to rotate out from under them.
 */
export function probeSubscriptionMode(): SubscriptionProbe {
  const claudeProjectsRoot = join(homedir(), ".claude/projects");
  return {
    claudeProjectsRoot,
    env: { ...Bun.env },
    nativeClaudeInstalled: existsSync(NATIVE_CLAUDE),
    projectsRootExists: existsSync(claudeProjectsRoot),
  };
}
