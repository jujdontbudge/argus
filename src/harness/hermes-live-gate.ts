/**
 * Ticket #47 — the gate for the live Hermes verification.
 *
 * `src/tailing/hermes.ts` is one of two transcript sources never continuously
 * verified against real output. Its live check looked for
 * `~/.hermes/profiles/argus-*​/state.db` and `test.skipIf`-ed itself away when
 * none existed — and none ever has, because a profile is created by `argus up`
 * and Argus has only run against sandboxes here. A check that can only skip
 * cannot fail, and a verification that cannot fail is not a verification.
 *
 * #43 made this argument for live-agent drives and split `gate-unset` from
 * `not-run` because collapsing them is how a half quietly passes. This module
 * reuses that convention rather than inventing a second one — same three
 * statuses, same title and banner helpers — over two halves:
 *
 *   - `scratch`: gated. Provisions its own profile under a scratch
 *     `HERMES_HOME` and drives the installed Hermes, so the check no longer
 *     waits on a deployment that may never happen here.
 *   - `real`: ungated and read-only. If `~/.hermes/profiles` ever exists it is
 *     read and never written. It has no `gate-unset` state by construction:
 *     it costs nothing, so it is always asked for, and its only skip is the
 *     honest one — this machine has no profile to read.
 *
 * Pure by construction, like #43's: every input arrives in the probe, so all
 * of the states below are tested without touching the real environment.
 */
import { constants, Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { LiveHalfStatus } from "./live-gate.ts";

/** Opt in with `ARGUS_LIVE_HERMES=1`, alongside #43's `ARGUS_LIVE_AGENTS`. */
export const LIVE_HERMES_GATE = "ARGUS_LIVE_HERMES";

export type HermesLiveHalf =
  /** The real `~/.hermes` tree, read-only, only if it exists. */
  | "real"
  /** A profile this suite provisions and drives itself. */
  | "scratch";

export interface HermesHalfVerdict {
  half: HermesLiveHalf;
  /** Plain English, and always populated — this is what the skip reports. */
  reason: string;
  status: LiveHalfStatus;
}

export interface HermesLiveProbe {
  env: Readonly<Record<string, string | undefined>>;
  hermesInstalled: boolean;
  /** A real `state.db` carrying an assistant row, or undefined. */
  realProfile: string | undefined;
}

export interface HermesLiveGate {
  enabled: boolean;
  real: HermesHalfVerdict;
  scratch: HermesHalfVerdict;
}

const GATE_SHUT =
  `${LIVE_HERMES_GATE} is unset — the default gate never requires a Hermes install`;

export function resolveHermesLiveGate(probe: HermesLiveProbe): HermesLiveGate {
  const enabled = probe.env[LIVE_HERMES_GATE] === "1";
  return {
    enabled,
    real: realHalf(probe),
    scratch: scratchHalf(enabled, probe),
  };
}

function scratchHalf(
  enabled: boolean,
  probe: HermesLiveProbe,
): HermesHalfVerdict {
  if (!enabled) return { half: "scratch", reason: GATE_SHUT, status: "gate-unset" };
  if (!probe.hermesInstalled) {
    return {
      half: "scratch",
      reason: "the hermes CLI is not on PATH",
      status: "not-run",
    };
  }
  return {
    half: "scratch",
    reason: "gate set and the hermes CLI is on PATH",
    status: "run",
  };
}

function realHalf(probe: HermesLiveProbe): HermesHalfVerdict {
  if (probe.realProfile === undefined) {
    return {
      half: "real",
      reason:
        "no ~/.hermes/profiles/argus-*/state.db holds an assistant row — a real " +
        "profile appears the first time Argus is deployed on a repo",
      status: "not-run",
    };
  }
  return {
    half: "real",
    reason: `${probe.realProfile} holds an assistant row, and is opened read-only`,
    status: "run",
  };
}

export interface ScratchDriveOutcome {
  /** null when the drive left a `state.db` behind; otherwise why it did not. */
  provisioningFailure: string | null;
}

/**
 * The third skip: the gate opened, hermes ran, and there is still nothing to
 * read.
 *
 * Where the line falls matters. "Could a profile be provisioned at all" is an
 * environment question and skips; everything AFTER a `state.db` exists — its
 * schema, its rows, what the source makes of them — is the verification, and
 * fails. Otherwise a regression in row persistence would report as a skip, and
 * a check that answers every regression with a skip is the thing this ticket
 * exists to remove.
 */
export function refineScratchVerdict(
  verdict: HermesHalfVerdict,
  outcome: ScratchDriveOutcome,
): HermesHalfVerdict {
  if (verdict.status !== "run" || outcome.provisioningFailure === null) {
    return verdict;
  }
  return {
    half: verdict.half,
    reason: `gate set, but the drive provisioned no profile: ${outcome.provisioningFailure}`,
    status: "not-run",
  };
}

export interface ScratchDriveEnv {
  /** The scratch profile directory. Everything the drive creates lands here. */
  hermesHome: string;
  /** The scratch HOME. Hermes also resolves a *global* root beneath it. */
  home: string;
}

/**
 * A credential-shaped variable name.
 *
 * A denylist of the providers we happen to know would be one upstream release
 * behind forever, so this matches on SHAPE — the suffix conventions every
 * provider's key follows — and drops the lot. Over-stripping costs the drive
 * nothing: it is deliberately meant to reach no provider at all.
 */
const CREDENTIAL_SHAPED =
  /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_BASE_URL|_API_BASE)$/;

/**
 * The child environment for a scratch drive.
 *
 * The point of this function is a negative one, and it is the hard rule of the
 * ticket made structural: a drive that cannot SEE a credential cannot spend
 * one. Nothing downstream has to remember to be careful, and no reviewer has
 * to take a promise on trust — the child is simply handed an environment with
 * no way to authenticate to anything.
 */
export function hermesDriveEnv(
  ambient: Readonly<Record<string, string | undefined>>,
  drive: ScratchDriveEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (CREDENTIAL_SHAPED.test(name)) continue;
    env[name] = value;
  }
  // Last, and unconditionally: these two decide which tree the drive touches,
  // so an ambient value must never be able to win.
  env.HERMES_HOME = drive.hermesHome;
  env.HOME = drive.home;
  return env;
}

/** The named custom provider the scratch profile declares. */
export const OFFLINE_PROVIDER = "argus-offline";

/**
 * Port 1 on loopback: reserved, privileged, and nothing on a developer machine
 * listens there. The address is the second half of the safety argument — the
 * env carries no credential, and the endpoint is unreachable — and it is what
 * lets the drive get PAST Hermes's "no inference provider configured" wall
 * without ever making a network call.
 */
export const OFFLINE_BASE_URL = "http://127.0.0.1:1/v1";

/**
 * The profile config that makes a credential-free drive persist a turn.
 *
 * Hermes with no provider at all refuses before writing anything: research §7's
 * scratch run got as far as a 401 precisely because it HAD a provider, and that
 * is why it could report on row persistence. This reproduces that state without
 * the 401's network call — a declared provider that cannot be dialled — so the
 * session and user rows land and the assistant row, as §7 says, does not.
 */
export function offlineProviderConfig(): string {
  return `providers:
  ${OFFLINE_PROVIDER}:
    base_url: ${OFFLINE_BASE_URL}
    api_key: argus-test-placeholder-not-a-credential
    model: gpt-4o-mini
model: gpt-4o-mini
provider: ${OFFLINE_PROVIDER}
`;
}

/** Where the opportunistic half looks, and the tree it must never write. */
export const REAL_HERMES_ROOT = join(homedir(), ".hermes");

/**
 * The first real profile carrying an assistant row, or undefined.
 *
 * Read-only in every sense the word has here: `mode=ro` plus
 * `SQLITE_OPEN_READONLY`, so the open cannot create a file, cannot upgrade a
 * schema and cannot checkpoint a WAL. This is the ONLY function in the live
 * Hermes path that touches the real home, and it only ever reads `state.db`.
 */
export function findRealProfile(hermesRoot = REAL_HERMES_ROOT): string | undefined {
  const profiles = join(hermesRoot, "profiles");
  if (!existsSync(profiles)) return undefined;
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("argus-")) continue;
    const file = join(profiles, entry.name, "state.db");
    if (!existsSync(file)) continue;
    let db: Database | undefined;
    try {
      db = new Database(
        `${pathToFileURL(file).href}?mode=ro&immutable=0`,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
      );
      const row = db
        .query<{ present: number }, []>(
          `SELECT 1 AS present
           FROM messages
           WHERE role = 'assistant' AND active = 1
           LIMIT 1`,
        )
        .get();
      if (row?.present === 1) return file;
    } catch {
      // Version/schema drift makes this profile ineligible for the read.
    } finally {
      db?.close();
    }
  }
  return undefined;
}

/**
 * This machine, right now. The only function here that reads the world, kept
 * separate so `resolveHermesLiveGate` stays pure and every state is testable.
 */
export function probeHermesLive(): HermesLiveProbe {
  return {
    env: { ...Bun.env },
    hermesInstalled: Bun.which("hermes") !== null,
    realProfile: findRealProfile(),
  };
}
