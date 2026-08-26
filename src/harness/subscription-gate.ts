/**
 * Ticket #49 — the gate for the subscription-mode Opus drive.
 *
 * #43 split `gate-unset` from `not-run` because collapsing them is how a half
 * quietly passes, and #47 reused that split rather than growing a second
 * vocabulary for the same three statuses. This module does the same: same
 * `LiveHalfStatus`, same `liveHalfTitle`, same banner words.
 *
 * AMENDED, and the amendment reverses this module's original wiring. It began
 * as a gate strictly separate from `ARGUS_LIVE_AGENTS`, on the reasoning that
 * #43's gate asks for the HERMETIC drive — which spends a token provisioned
 * for automation — and must never silently spend Johan's own quota instead.
 *
 * SPEC §1 removed the choice that argued for: **Argus must never require
 * Anthropic API access**, and Johan's plan permits none, so no such token can
 * exist on this machine. Keeping the gates separate would not have produced a
 * hermetic run; it would have produced NO Claude run, for want of a credential
 * that cannot be minted — the exact outcome §1 forbids. So `ARGUS_LIVE_AGENTS=1`
 * opens this gate too: whoever asks for the live Claude drive gets the drive,
 * and subscription mode is what that drive is by default.
 *
 * `ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1` stays, for running the Claude half alone
 * without also burning a Codex call.
 *
 * WHAT STILL SEPARATES THE MODES is not an env var and never was: it is the
 * SPAWNER's name. `createSubscriptionAgentSpawner` is the only function in the
 * tree that puts the real `HOME` into a child, and it must be named to be
 * called. No env var reaches the real home. So the modes still differ by
 * deliberate choice, never by a forgotten argument — the choice just lives
 * where it is enforced instead of where it was merely announced.
 *
 * Pure by construction like both predecessors: every input arrives in the
 * probe, so all states are testable without touching the real environment.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  LIVE_AGENT_GATE,
  LIVE_HALF_BANNER,
  type LiveHalfOutcome,
  type LiveHalfStatus,
} from "./live-gate.ts";

/** Opt in with `ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1` — or with #43's gate. */
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
  /**
   * WHICH variable opened it, or `null` if none did.
   *
   * Two gates open this drive, so the banner cannot hard-code one name without
   * telling a reader to unset a variable they never set. Whoever spent a
   * subscription call is entitled to know what spent it.
   */
  openedBy: string | null;
}

const GATE_SHUT =
  `${LIVE_SUBSCRIPTION_GATE} is unset — the default gate never spends Johan's subscription`;

export function resolveSubscriptionGate(probe: SubscriptionProbe): SubscriptionGate {
  // Either gate. #43's asks for the live Claude drive, and since SPEC §1 this
  // IS the live Claude drive; this one asks for it without the Codex burn.
  const openedBy =
    [LIVE_SUBSCRIPTION_GATE, LIVE_AGENT_GATE].find(
      (name) => probe.env[name] === "1",
    ) ?? null;
  const enabled = openedBy !== null;
  return { claude: half(enabled, probe), enabled, openedBy };
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
    return `argus: subscription-mode Claude drive SKIPPED — set ${LIVE_SUBSCRIPTION_GATE}=1 (or ${LIVE_AGENT_GATE}=1) to run it; it spends Johan's own subscription (no token)`;
  }
  return [
    `${gate.openedBy}=1 — the subscription-mode Claude drive is ENABLED`,
    `  claude  ${banner[gate.claude.status]}  ${gate.claude.reason}`,
    "  real HOME, sandbox cwd, no token: the blast radius here is scripted scope, not an OS boundary",
    "  SPEC §1: Argus never requires Anthropic API access — this is the default live-Claude path",
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
