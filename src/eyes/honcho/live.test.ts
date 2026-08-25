import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProvenanceRecord } from "../../provenance";
import { HttpHonchoClient } from "../../up/bindings";
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

const live = await (async (): Promise<{ apiKey: string } | null> => {
  const apiKey = await configuredApiKey();
  if (!apiKey) return null;
  try {
    const response = await fetch(`${LIVE_URL}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok ? { apiKey } : null;
  } catch {
    return null;
  }
})();

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

const liveTest = live === null ? test.skip : test;

liveTest(
  "live local Honcho accepts a scratch eye batch and cleans up session then workspace",
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
