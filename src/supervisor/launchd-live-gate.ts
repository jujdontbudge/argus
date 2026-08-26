import type { LiveHalfOutcome } from "../harness/live-gate.ts";

export const LIVE_LAUNCHD_SMOKE_GATE = "ARGUS_LIVE_LAUNCHD_SMOKE";

export interface LaunchdSmokeProbe {
  codexPath: string | null;
  env: Readonly<Record<string, string | undefined>>;
  ghPath: string | null;
  launchctlAvailable: boolean;
  platform: NodeJS.Platform;
}

export function resolveLaunchdSmokeGate(
  probe: LaunchdSmokeProbe,
): LiveHalfOutcome {
  if (probe.env[LIVE_LAUNCHD_SMOKE_GATE] !== "1") {
    return {
      reason: `${LIVE_LAUNCHD_SMOKE_GATE} is unset — the default suite never controls launchd`,
      status: "gate-unset",
    };
  }
  if (probe.platform !== "darwin") {
    return { reason: "launchd is only available on macOS", status: "not-run" };
  }
  if (!probe.launchctlAvailable) {
    return { reason: "/bin/launchctl is not executable", status: "not-run" };
  }
  if (probe.codexPath === null) {
    return { reason: "the codex CLI is not on PATH", status: "not-run" };
  }
  if (probe.ghPath === null) {
    return { reason: "the gh CLI is not on PATH", status: "not-run" };
  }
  return {
    reason: "gate set; launchctl, codex, and gh are present",
    status: "run",
  };
}
