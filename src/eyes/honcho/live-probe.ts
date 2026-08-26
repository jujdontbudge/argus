/**
 * The one place that decides whether a REAL Honcho instance is reachable.
 *
 * EXTRACTED BY #76 from `live.test.ts`, which owned this logic privately. The
 * §13.9 semantic-isolation slot needs exactly the same decision — is there a
 * live instance, and if not, WHY — and two copies of that decision is how the
 * two halves start disagreeing about what "live" means.
 *
 * SPEC §1 items 7 and 8. The key read here is a LOCAL, self-hosted Honcho's
 * bearer credential, not metered model access from any vendor: Argus requires
 * no Anthropic or OpenAI key to run, and nothing in this file consults one.
 * The three statuses are #43's and #68's — `gate-unset` when nobody asked,
 * `not-run` when someone asked and the local service or its credential is
 * genuinely absent, and never a silent pass.
 */
import { join } from "node:path";

/** The self-hosted instance `argus up` binds every repo to by default. */
export const LIVE_HONCHO_URL = "http://localhost:8000";

export interface LiveHonchoProbe {
  live: { apiKey: string } | null;
  reason: string | null;
}

/** Never printed, logged, compared or shortened anywhere. */
export async function configuredHonchoApiKey(): Promise<string | null> {
  const environmentKey = Bun.env.HONCHO_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  const home = Bun.env.HOME;
  if (!home) return null;
  try {
    const config = (await Bun.file(join(home, ".honcho/config.json")).json()) as {
      apiKey?: unknown;
    };
    return typeof config.apiKey === "string" && config.apiKey.trim()
      ? config.apiKey.trim()
      : null;
  } catch {
    return null;
  }
}

export async function probeLiveHoncho(): Promise<LiveHonchoProbe> {
  const apiKey = await configuredHonchoApiKey();
  if (!apiKey) {
    return { live: null, reason: "Honcho credentials are not configured" };
  }
  try {
    const response = await fetch(`${LIVE_HONCHO_URL}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok
      ? { live: { apiKey }, reason: null }
      : {
          live: null,
          reason: `the local Honcho health check returned ${response.status}`,
        };
  } catch {
    return { live: null, reason: "the local Honcho service is unavailable" };
  }
}

function authorized(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

/** A read of the live instance, by the harness, in the harness's own words. */
export async function honchoQuery<T>(
  apiKey: string,
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`${LIVE_HONCHO_URL}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...authorized(apiKey), "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Honcho ${method} ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Remove a scratch workspace and everything under it.
 *
 * Workspace deletion is asynchronous on the service and returns 409 while its
 * sessions are still being torn down, so this retries rather than trusting the
 * first response — a scratch workspace left behind on Johan's own instance is
 * exactly the residue SPEC §13 tells the harness not to leave.
 */
export async function removeScratchWorkspace(
  apiKey: string,
  workspace: string,
  sessions: readonly string[] = [],
): Promise<void> {
  const headers = authorized(apiKey);
  const encodedWorkspace = encodeURIComponent(workspace);
  for (const session of sessions) {
    await fetch(
      `${LIVE_HONCHO_URL}/v3/workspaces/${encodedWorkspace}/sessions/${encodeURIComponent(session)}`,
      { method: "DELETE", headers },
    );
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(
      `${LIVE_HONCHO_URL}/v3/workspaces/${encodedWorkspace}`,
      { method: "DELETE", headers },
    );
    if (response.status === 202 || response.status === 404) return;
    if (response.status !== 409) {
      throw new Error(`scratch cleanup failed: Honcho ${response.status}`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`scratch cleanup timed out for ${workspace}`);
}
