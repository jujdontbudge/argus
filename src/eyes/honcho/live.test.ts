import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveHalfTitle } from "../../harness/live-gate";
import type { ProvenanceRecord } from "../../provenance";
import { HttpHonchoClient } from "../../up/bindings";
import {
  describeLiveIntegrationGate,
  LIVE_HONCHO_GATE,
  liveGateEnabled,
  resolveHonchoGate,
} from "../live-gate";
import { HonchoEye } from "./honcho";

const LIVE_URL = "http://localhost:8000";

async function configuredApiKey(): Promise<string | null> {
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

async function probeLiveHoncho(): Promise<{
  live: { apiKey: string } | null;
  reason: string | null;
}> {
  const apiKey = await configuredApiKey();
  if (!apiKey) {
    return { live: null, reason: "Honcho credentials are not configured" };
  }
  try {
    const response = await fetch(`${LIVE_URL}/health`, {
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

const probe = liveGateEnabled(LIVE_HONCHO_GATE, Bun.env)
  ? await probeLiveHoncho()
  : { live: null, reason: null };
const live = probe.live;
const liveGate = resolveHonchoGate(Bun.env, probe.reason);
console.log(
  describeLiveIntegrationGate(
    "live local Honcho integration",
    LIVE_HONCHO_GATE,
    liveGate,
  ),
);

async function cleanup(
  apiKey: string,
  workspace: string,
  session: string,
): Promise<void> {
  const headers = { authorization: `Bearer ${apiKey}` };
  const encodedWorkspace = encodeURIComponent(workspace);
  await fetch(
    `${LIVE_URL}/v3/workspaces/${encodedWorkspace}/sessions/${encodeURIComponent(session)}`,
    { method: "DELETE", headers },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${LIVE_URL}/v3/workspaces/${encodedWorkspace}`, {
      method: "DELETE",
      headers,
    });
    if (response.status === 202 || response.status === 404) return;
    if (response.status !== 409) {
      throw new Error(`scratch cleanup failed: Honcho ${response.status}`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`scratch cleanup timed out for ${workspace}`);
}

function liveRecord(sessionId: string, text: string): ProvenanceRecord {
  const ts = new Date().toISOString();
  return {
    sessionId,
    author: "johan",
    via: "takeover",
    registered: true,
    startedBy: "hermes",
    johanTouched: true,
    agent: "codex",
    ticket: "32",
    ts,
    text,
    event: {
      type: "message",
      sessionId,
      role: "user",
      text,
      ts,
      uuid: randomUUID(),
      candidate: true,
      file: `/scratch/${sessionId}.jsonl`,
    },
  };
}

const liveTest = liveGate.status === "run" ? test : test.skip;

liveTest(
  liveHalfTitle(
    "live local Honcho accepts a scratch eye batch and cleans up session then workspace",
    liveGate,
  ),
  async () => {
    const suffix = randomUUID();
    const workspace = `scratch-argus-honcho-eye-${suffix}`;
    const session = `scratch-session-${suffix}`;
    const repo = await mkdtemp(join(tmpdir(), "scratch-argus-honcho-live-"));
    await Bun.write(
      join(repo, ".argus/honcho.yaml"),
      `url: ${LIVE_URL}\nworkspace: ${workspace}\n`,
    );

    try {
      const eye = await HonchoEye.open({
        repo,
        client: new HttpHonchoClient(LIVE_URL, live!.apiKey, 5_000),
        autoFlush: false,
        onAlert: () => {},
      });
      await eye.ingest([
        liveRecord(session, "scratch live verification from ticket 32"),
      ]);
      await eye.flush();

      // Delivery, not representation availability, is the gate. Honcho's
      // Deriver intentionally waits for 512 tokens or 30 minutes.
      expect(await eye.pendingCount()).toBe(0);
    } finally {
      await cleanup(live!.apiKey, workspace, session);
      await rm(repo, { force: true, recursive: true });
    }
  },
  30_000,
);
