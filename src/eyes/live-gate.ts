import {
  LIVE_HALF_BANNER,
  type LiveHalfOutcome,
} from "../harness/live-gate";

export const LIVE_WATCHER_BRAINS_GATE = "ARGUS_LIVE_WATCHER_BRAINS";
export const LIVE_HONCHO_GATE = "ARGUS_LIVE_HONCHO";

export interface WatcherBrainGateProbe {
  codexInstalled: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export function resolveWatcherBrainGate(
  probe: WatcherBrainGateProbe,
): LiveHalfOutcome {
  if (probe.env[LIVE_WATCHER_BRAINS_GATE] !== "1") {
    return {
      reason: `${LIVE_WATCHER_BRAINS_GATE} is unset — the default gate never spends a subscription call`,
      status: "gate-unset",
    };
  }
  if (!probe.codexInstalled) {
    return { reason: "the codex CLI is not on PATH", status: "not-run" };
  }
  return {
    reason: "gate set and the subscription-backed codex CLI is on PATH",
    status: "run",
  };
}

export function liveGateEnabled(
  gateName: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[gateName] === "1";
}

export function resolveHonchoGate(
  env: Readonly<Record<string, string | undefined>>,
  unavailableReason: string | null,
): LiveHalfOutcome {
  if (!liveGateEnabled(LIVE_HONCHO_GATE, env)) {
    return {
      reason: `${LIVE_HONCHO_GATE} is unset — the default gate never touches a Honcho service`,
      status: "gate-unset",
    };
  }
  if (unavailableReason !== null) {
    return { reason: unavailableReason, status: "not-run" };
  }
  return {
    reason: "gate set, credentials configured, and the local Honcho service is healthy",
    status: "run",
  };
}

export function describeLiveIntegrationGate(
  label: string,
  gateName: string,
  outcome: LiveHalfOutcome,
): string {
  if (outcome.status === "gate-unset") {
    return `argus: ${label} SKIPPED — set ${gateName}=1 to run it explicitly`;
  }
  return `argus: ${label} ${LIVE_HALF_BANNER[outcome.status].trim()} — ${outcome.reason}`;
}
