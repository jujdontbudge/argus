/**
 * Ticket #43 — the permanent opt-in gate for live-agent drives.
 *
 * AMENDED BY #49, and the amendment is the load-bearing part of this file now.
 * SPEC §1: **Argus must never require Anthropic API access.** Johan's Claude
 * plan does not permit it, so a design that needs an API key or an out-of-band
 * `claude setup-token` credential is — his words — "unusably useless". This
 * module used to return `"CLAUDE_CODE_OAUTH_TOKEN is not provisioned —
 * generate one out of band"` as a BLOCKING reason, which meant the Claude half
 * of §13 reported NOT RUN forever on the only machine Argus runs on, for want
 * of a credential that machine can never have. An absent token now selects the
 * OTHER mode instead of blocking the half: subscription mode, which needs no
 * token at all. Nothing here can produce `not-run` from a missing token.
 *
 * SPEC §13 names Claude Opus 5 and Codex sol high as the two test agents, but
 * a live drive costs a real subscription call, so it can never be part of the
 * gate everyone runs. #36 solved that by keeping the drive OUT of `bun test`
 * as a script; the cost of that was a drive nothing reminds you to run.
 *
 * This module is the third option: the drive lives in the suite permanently
 * and is skipped by default, with the reason for the skip carried in the test
 * NAME so it is legible in the default transcript rather than silently absent.
 *
 * Pure by construction — every input arrives in the probe, so the decision can
 * be tested for all nine states without touching the real environment.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TestAgent } from "./index.ts";

/** Opt in with `ARGUS_LIVE_AGENTS=1`, after `ARGUS_LIVE_LAUNCHD_SMOKE`. */
export const LIVE_AGENT_GATE = "ARGUS_LIVE_AGENTS";

/**
 * Which Claude path a live drive takes — a choice, never an accident.
 *
 * `subscription` is the DEFAULT and the only REQUIRED path (#49): a normal
 * `claude --model claude-opus-5` under the real `HOME`, no token, `cwd` pinned
 * to the throwaway sandbox. `hermetic` is the OPTIONAL stricter path (#41),
 * selected only by actually having a `CLAUDE_CODE_OAUTH_TOKEN`, and it buys an
 * OS-enforced boundary at the cost of a credential this machine cannot mint.
 *
 * The two are separate SPAWNERS with separate names —
 * `createSubscriptionAgentSpawner` and `createIsolatedAgentSpawner` — and this
 * field selects which drive registers, never which `HOME` a spawner uses. The
 * real home stays reachable only by naming the subscription spawner.
 */
export type ClaudeLiveMode = "hermetic" | "subscription";

export type LiveHalfStatus =
  /** The gate is shut. Nobody asked for a live call, so nobody pays for one. */
  | "gate-unset"
  /** Asked for, but a credential or CLI this half needs is not provisioned. */
  | "not-run"
  | "run";

/**
 * The part of a verdict the title and banner helpers actually read.
 *
 * ADDITIVE, #47: widened from `LiveHalfVerdict` so a half that is not an agent
 * — the live Hermes verification's `scratch` and `real` halves — can reuse
 * `liveHalfTitle` and `LIVE_HALF_BANNER` instead of growing a second, drifting
 * vocabulary for the same three statuses. Every `LiveHalfVerdict` still
 * satisfies it, so no existing call site changes.
 */
export interface LiveHalfOutcome {
  /** Plain English, and always populated — this is what the skip reports. */
  reason: string;
  status: LiveHalfStatus;
}

export interface LiveHalfVerdict extends LiveHalfOutcome {
  agent: TestAgent;
}

/** The Claude half also reports WHICH of the two modes it resolved to. */
export interface LiveClaudeVerdict extends LiveHalfVerdict {
  agent: "claude";
  mode: ClaudeLiveMode;
}

export interface LiveAgentProbe {
  claudeInstalled: boolean;
  codexAuthPresent: boolean;
  codexInstalled: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export interface LiveAgentGate {
  claude: LiveClaudeVerdict;
  codex: LiveHalfVerdict;
  enabled: boolean;
}

const READY_CODEX = "gate set and the codex CLI and auth.json are both present";

const READY_CLAUDE: Readonly<Record<ClaudeLiveMode, string>> = {
  hermetic: "gate set and CLAUDE_CODE_OAUTH_TOKEN is provisioned — hermetic mode",
  subscription:
    "gate set and no token is needed — the Claude half runs in subscription mode",
};

/** Why the OPTIONAL stricter drive did not register. A SKIP, never a NOT RUN. */
const HERMETIC_NOT_SELECTED =
  "no CLAUDE_CODE_OAUTH_TOKEN — the optional hermetic mode is not selected; the Claude half runs in subscription mode";

const GATE_SHUT =
  `${LIVE_AGENT_GATE} is unset — the default gate never burns a subscription`;

/** SPEC §1, on the banner, so nobody re-derives the token requirement. */
const NO_API_ACCESS =
  "  SPEC §1: Argus never requires Anthropic API access — real HOME, sandbox cwd, scripted scope";

export function resolveLiveAgentGate(probe: LiveAgentProbe): LiveAgentGate {
  const enabled = probe.env[LIVE_AGENT_GATE] === "1";
  const half = (agent: TestAgent, missing: string | null): LiveHalfVerdict => {
    if (!enabled) return { agent, reason: GATE_SHUT, status: "gate-unset" };
    if (missing !== null) return { agent, reason: missing, status: "not-run" };
    return { agent, reason: READY_CODEX, status: "run" };
  };

  return {
    claude: claudeHalf(enabled, probe),
    codex: half("codex", missingForCodex(probe)),
    enabled,
  };
}

/**
 * The Claude half — and the one place the amendment actually bites.
 *
 * There is exactly one blocking condition left, and it is the absence of the
 * CLI itself. A missing token is not a blocker; it is how a caller SELECTS
 * subscription mode, which is the default and needs no credential.
 */
function claudeHalf(enabled: boolean, probe: LiveAgentProbe): LiveClaudeVerdict {
  // Deliberately a presence test and nothing more: the value is a credential,
  // so it is never read, compared, logged or shortened anywhere in the gate.
  const token = probe.env.CLAUDE_CODE_OAUTH_TOKEN;
  const mode: ClaudeLiveMode =
    token === undefined || token === "" ? "subscription" : "hermetic";

  if (!enabled) return { agent: "claude", mode, reason: GATE_SHUT, status: "gate-unset" };
  if (!probe.claudeInstalled) {
    return {
      agent: "claude",
      mode,
      reason: "the claude CLI is not on PATH",
      status: "not-run",
    };
  }
  return { agent: "claude", mode, reason: READY_CLAUDE[mode], status: "run" };
}

/**
 * The verdict the OPTIONAL hermetic drive registers under.
 *
 * Without a token that drive genuinely cannot run — but calling that NOT RUN
 * would report a gap that does not exist, because the Claude half IS running,
 * in the other mode. So it is `gate-unset`: nobody asked for the stricter
 * mode, and nobody is paying for it. A shut outer gate outranks the mode,
 * because that is the reason a reader needs first.
 */
export function hermeticClaudeHalf(gate: LiveAgentGate): LiveHalfOutcome {
  if (!gate.enabled) return gate.claude;
  if (gate.claude.mode === "subscription") {
    return { reason: HERMETIC_NOT_SELECTED, status: "gate-unset" };
  }
  return gate.claude;
}

function missingForCodex(probe: LiveAgentProbe): string | null {
  if (!probe.codexInstalled) return "the codex CLI is not on PATH";
  // The one production touchpoint SPEC §13 permits a live drive: a COPY of
  // auth.json into a scratch CODEX_HOME, exactly as the live-luna tests do.
  if (!probe.codexAuthPresent) return "~/.codex/auth.json is not present";
  return null;
}

/**
 * The test name a half is registered under.
 *
 * `bun test` prints the NAME of a skipped test and nothing else about it, so
 * the name is the only channel a skip has. Putting the reason there is what
 * makes "not run" legible in the default transcript instead of looking like a
 * test that was never written — and what distinguishes SKIPPED (nobody asked)
 * from NOT RUN (asked for, and a credential is missing).
 */
export function liveHalfTitle(base: string, verdict: LiveHalfOutcome): string {
  switch (verdict.status) {
    case "gate-unset":
      return `${base} — SKIPPED: ${verdict.reason}`;
    case "not-run":
      return `${base} — NOT RUN: ${verdict.reason}`;
    case "run":
      return base;
  }
}

/** ADDITIVE, #47: exported so the live Hermes banner uses these exact words. */
export const LIVE_HALF_BANNER: Readonly<Record<LiveHalfStatus, string>> = {
  "gate-unset": "SKIPPED",
  "not-run": "NOT RUN",
  run: "RUN    ",
};

/**
 * The line the suite prints, whatever the gate says.
 *
 * `bun test` (1.3.12) prints no name for a skipped test — only an aggregate
 * `N skip` — so the test NAME is not on its own a visible channel. This is,
 * and it is the reason a skipped drive can never read as a drive that was
 * never written. One line when the gate is shut, because on the default path
 * both halves have the same reason and nobody needs it twice.
 *
 * When the gate is OPEN it expands to name every half, including the case
 * where nothing is provisioned: a green suite of structural tests plus two
 * quiet skips otherwise reads exactly like a successful live run.
 */
export function describeLiveAgentGate(gate: LiveAgentGate): string {
  const halves = [gate.claude, gate.codex];
  if (!gate.enabled) {
    const agents = halves.map(({ agent }) => agent).join(", ");
    return `argus: live agent drives SKIPPED (${agents}) — set ${LIVE_AGENT_GATE}=1 to run them; they burn a subscription`;
  }
  const lines = halves.map(
    (verdict) =>
      `  ${verdict.agent.padEnd(6)}  ${LIVE_HALF_BANNER[verdict.status]}  ${verdict.reason}`,
  );
  const head = `${LIVE_AGENT_GATE}=1 — live agent drives are ENABLED (this burns a subscription)`;
  if (halves.every(({ status }) => status !== "run")) {
    return [head, ...lines, "  NO live half can run on this machine"].join("\n");
  }
  // #49: when the Claude half resolved to subscription mode, say why no token
  // is being asked for. Otherwise a reader who remembers the old banner reads
  // "no token" as something that went missing rather than as the design.
  if (gate.claude.mode === "subscription" && gate.claude.status === "run") {
    return [head, ...lines, NO_API_ACCESS].join("\n");
  }
  return [head, ...lines].join("\n");
}

/** Where a live Codex drive copies its one permitted production credential. */
export const CODEX_AUTH_FILE = join(homedir(), ".codex/auth.json");

/**
 * This machine, right now. The only function here that reads the world, kept
 * separate so `resolveLiveAgentGate` stays pure and every state is testable.
 */
export function probeLiveAgents(): LiveAgentProbe {
  return {
    claudeInstalled: Bun.which("claude") !== null,
    // Existence only. The file holds a credential and is never opened here.
    codexAuthPresent: existsSync(CODEX_AUTH_FILE),
    codexInstalled: Bun.which("codex") !== null,
    env: { ...Bun.env },
  };
}
