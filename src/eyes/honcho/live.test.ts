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
import {
  LIVE_HONCHO_URL as LIVE_URL,
  probeLiveHoncho,
  removeScratchWorkspace,
} from "./live-probe";

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
      await removeScratchWorkspace(live!.apiKey, workspace, [session]);
      await rm(repo, { force: true, recursive: true });
    }
  },
  30_000,
);
