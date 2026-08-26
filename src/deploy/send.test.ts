import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CmuxSendRequest, CmuxSendResult, CmuxTarget } from "../events";
import {
  appendSessionRow,
  classifierFromRegistry,
  loadRegistry,
  registryPaths,
} from "../provenance";
import type { MessageEvent } from "../tailing";
import { sendToWorker } from "./index.ts";

/**
 * Ticket #55 — SPEC §5 rule 2 for REAL worker traffic.
 *
 * `notifyMissionControl` already logs before it types, but it only ever does
 * so for one kind of message (an `[argus]` event line) aimed at one kind of
 * session (Hermes' own mission workspace). Every follow-up Hermes types into a
 * WORKER — "gates are red, fix and re-run", "merged, close it" — had no
 * production path at all, which is why the audit calls rule 2 partial.
 *
 * The ordering assertions below are made from inside the delivery seam, at the
 * instant the keystrokes would be sent, for the same reason the deployment
 * tests read the registry from inside spawn: an after-the-fact check passes
 * just as happily when the two are swapped.
 */
async function repoWithSession(sessionId: string, workspace?: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-send-"));
  await appendSessionRow(registryPaths(repo).sessionsFile, {
    agent: "claude",
    dispatchPrompt: "You are working ticket #55.",
    sessionId,
    ticket: "55",
    ts: "2026-08-26T00:00:00.000Z",
    ...(workspace !== undefined && { workspace }),
  });
  return repo;
}

const SESSION = "cccccccc-dddd-4eee-8fff-000000000000";
const FOLLOW_UP = "gates are red on the worktree; fix and re-run before you report";

describe("sendToWorker (#55): logged before typed, or not typed at all", () => {
  test("sends.jsonl holds the text before a single key is delivered", async () => {
    const repo = await repoWithSession(SESSION, "workspace:14");
    try {
      const sendsAtDelivery: string[] = [];
      const delivered: CmuxSendRequest[] = [];
      const result = await sendToWorker(
        { repo, sessionId: SESSION, text: FOLLOW_UP },
        {
          resolve: async (_target: CmuxTarget): Promise<CmuxSendResult> => ({ ok: true }),
          send: async (request): Promise<CmuxSendResult> => {
            delivered.push(request);
            const file = Bun.file(registryPaths(repo).sendsFile);
            sendsAtDelivery.push((await file.exists()) ? await file.text() : "");
            return { ok: true };
          },
        },
      );
      expect(result.status).toBe("sent");

      // THE ORDERING PROOF: the registry as another reader saw it at the
      // moment the keystrokes went out. Swap record and deliver, and this is
      // the empty string.
      const logged = JSON.parse((sendsAtDelivery[0] ?? "").trim()) as Record<string, unknown>;
      expect(logged.text).toBe(FOLLOW_UP);
      expect(logged.sessionId).toBe(SESSION);
      expect(delivered[0]?.workspace).toBe("workspace:14");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a session the registry does not know is refused, and nothing is logged", async () => {
    const repo = await repoWithSession(SESSION, "workspace:14");
    try {
      let deliveries = 0;
      const result = await sendToWorker(
        { repo, sessionId: "not-a-registered-session", text: FOLLOW_UP },
        {
          resolve: async () => ({ ok: true }),
          send: async () => {
            deliveries += 1;
            return { ok: true };
          },
        },
      );
      expect(result.status).toBe("refused");
      expect(deliveries).toBe(0);
      expect((await loadRegistry(registryPaths(repo))).sends).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("an unresolvable cmux handle is refused BEFORE the send is logged (#7)", async () => {
    const repo = await repoWithSession(SESSION, "workspace:9999");
    try {
      let deliveries = 0;
      const result = await sendToWorker(
        { repo, sessionId: SESSION, text: FOLLOW_UP },
        {
          resolve: async () => ({
            error: "cmux does not resolve workspace:9999; refusing to type into the focused workspace instead",
            ok: false,
          }),
          send: async () => {
            deliveries += 1;
            return { ok: true };
          },
        },
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") expect(result.reason).toContain("does not resolve");
      expect(deliveries).toBe(0);
      // A send logged but never delivered is a phantom Hermes attribution: the
      // same words typed later by Johan would match it and stop being his.
      expect((await loadRegistry(registryPaths(repo))).sends).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a session with no workspace is refused, not silently dropped", async () => {
    const repo = await repoWithSession(SESSION);
    try {
      const result = await sendToWorker(
        { repo, sessionId: SESSION, text: FOLLOW_UP },
        { resolve: async () => ({ ok: true }), send: async () => ({ ok: true }) },
      );
      expect(result.status).toBe("refused");
      expect((await loadRegistry(registryPaths(repo))).sends).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("delivery that fails after logging stays logged and reports degraded", async () => {
    const repo = await repoWithSession(SESSION, "workspace:14");
    try {
      const result = await sendToWorker(
        { repo, sessionId: SESSION, text: FOLLOW_UP },
        {
          resolve: async () => ({ ok: true }),
          send: async () => ({ error: "cmux send exited 1", ok: false }),
        },
      );
      expect(result.status).toBe("degraded");
      // Rule 2 is one-directional: never type an unlogged send. A logged send
      // that failed to land is the case the matcher already audits loudly
      // (`send-expired`), and erasing it would be the unlogged-send hazard.
      expect((await loadRegistry(registryPaths(repo))).sends.map((s) => s.text)).toEqual([
        FOLLOW_UP,
      ]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("the logged row makes the landing hermes/registry-send, not johan/takeover", async () => {
    const repo = await repoWithSession(SESSION, "workspace:14");
    try {
      await sendToWorker(
        { now: () => new Date("2026-08-26T01:00:00.000Z"), repo, sessionId: SESSION, text: FOLLOW_UP },
        { resolve: async () => ({ ok: true }), send: async () => ({ ok: true }) },
      );
      const { classifier } = classifierFromRegistry(
        await loadRegistry(registryPaths(repo)),
      );
      const landing: MessageEvent = {
        candidate: true,
        file: "/transcript.jsonl",
        promptSource: "typed",
        role: "user",
        sessionId: SESSION,
        text: FOLLOW_UP,
        ts: "2026-08-26T01:00:02.000Z",
        type: "message",
      };
      const { record } = classifier.handle(landing);
      expect({ author: record?.author, via: record?.via }).toEqual({
        author: "hermes",
        via: "registry-send",
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});
