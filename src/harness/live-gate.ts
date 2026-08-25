/**
 * Ticket #43 — the permanent opt-in gate for live-agent drives.
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

export interface LiveAgentProbe {
  claudeInstalled: boolean;
  codexAuthPresent: boolean;
  codexInstalled: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export interface LiveAgentGate {
  claude: LiveHalfVerdict;
  codex: LiveHalfVerdict;
  enabled: boolean;
}

const READY: Readonly<Record<TestAgent, string>> = {
  claude: "gate set and CLAUDE_CODE_OAUTH_TOKEN is provisioned",
  codex: "gate set and the codex CLI and auth.json are both present",
};

const GATE_SHUT =
  `${LIVE_AGENT_GATE} is unset — the default gate never burns a subscription`;

export function resolveLiveAgentGate(probe: LiveAgentProbe): LiveAgentGate {
  const enabled = probe.env[LIVE_AGENT_GATE] === "1";
  const half = (agent: TestAgent, missing: string | null): LiveHalfVerdict => {
    if (!enabled) return { agent, reason: GATE_SHUT, status: "gate-unset" };
    if (missing !== null) return { agent, reason: missing, status: "not-run" };
    return { agent, reason: READY[agent], status: "run" };
  };

  return {
    claude: half("claude", missingForClaude(probe)),
    codex: half("codex", missingForCodex(probe)),
    enabled,
  };
}

/** The first thing standing between this machine and a live Claude call. */
function missingForClaude(probe: LiveAgentProbe): string | null {
  if (!probe.claudeInstalled) return "the claude CLI is not on PATH";
  // Deliberately a presence test and nothing more: the value is a credential,
  // so it is never read, compared, logged or shortened anywhere in the gate.
  const token = probe.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token === undefined || token === "") {
    return "CLAUDE_CODE_OAUTH_TOKEN is not provisioned — generate one out of band";
  }
  return null;
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
