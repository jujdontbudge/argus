import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEvent, ProvenanceRecord } from "../../provenance";
import type { SessionRecord } from "../../provenance";
import type { Brain, BrainRequest } from "../brain";
import { createBrainCap } from "../cap";
import { DigestEye, openDigest } from "./digest";

const CADENCE = { quietWindowSeconds: 30, maxWaitSeconds: 120 };
const SECOND = 1_000;

interface RecordOptions {
  sessionId?: string;
  author?: ProvenanceRecord["author"];
  ticket?: string;
  johanTouched?: boolean;
  ts?: string;
}

function record(text: string, options: RecordOptions = {}): ProvenanceRecord {
  const sessionId = options.sessionId ?? "sess-1";
  const author = options.author ?? "agent";
  const event: MessageEvent = {
    type: "message",
    sessionId,
    role: author === "agent" ? "assistant" : "user",
    text,
    ts: options.ts ?? "2026-08-24T12:00:00.000Z",
    uuid: `uuid-${text.length}-${text.slice(0, 8)}`,
    candidate: author !== "agent",
    file: `/transcripts/${sessionId}.jsonl`,
  };
  return {
    sessionId,
    author,
    via: author === "johan" ? "takeover" : author === "hermes" ? "registry-send" : "assistant",
    registered: true,
    startedBy: "hermes",
    johanTouched: options.johanTouched ?? false,
    agent: "claude",
    ...(options.ticket !== undefined && { ticket: options.ticket }),
    ts: event.ts,
    text,
    event,
  };
}

interface ScriptedBrain {
  brain: Brain;
  requests: BrainRequest[];
}

/** Returns each scripted text in turn; repeats the last one when exhausted. */
function scriptedBrain(texts: string[]): ScriptedBrain {
  const requests: BrainRequest[] = [];
  return {
    requests,
    brain: {
      async evaluate(request) {
        requests.push(request);
        return { ok: true, text: texts[Math.min(requests.length - 1, texts.length - 1)]! };
      },
    },
  };
}

const verdict = (
  sessions: Array<{ sessionId: string; status?: string; narrative?: string; summary?: string }>,
): string =>
  JSON.stringify({
    sessions: sessions.map((session) => ({
      narrative: "worked",
      summary: "at it",
      status: "running",
      ...session,
    })),
  });

interface World {
  repo: string;
  open: (
    brain: Brain,
    overrides?: Partial<Parameters<typeof DigestEye.open>[0]>,
  ) => Promise<DigestEye>;
  clock: { now: () => number; set: (ms: number) => void };
  read: (name: string) => Promise<string>;
  exists: (name: string) => Promise<boolean>;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-digest-eye-"));
  const repo = join(root, "repo");
  let nowMs = 0;
  try {
    await body({
      repo,
      clock: { now: () => nowMs, set: (ms) => void (nowMs = ms) },
      open: (brain, overrides = {}) =>
        DigestEye.open({
          repo,
          brain,
          cap: createBrainCap({
            directory: join(root, "slots"),
            maxConcurrency: 2,
            pollMs: 1,
          }),
          cadence: CADENCE,
          now: () => nowMs,
          sleep: async (ms) => void (nowMs += ms),
          onAlert: () => {},
          ...overrides,
        }),
      read: (name) => Bun.file(join(repo, ".argus/sessions", name)).text(),
      exists: (name) => Bun.file(join(repo, ".argus/sessions", name)).exists(),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("immediate lifecycle surfacing (no brain involved)", () => {
  test("a first-seen session gets its digest file and INDEX line at ingest", async () => {
    await withWorld(async ({ open, read, exists }) => {
      const { brain, requests } = scriptedBrain([verdict([])]);
      const eye = await open(brain);
      await eye.ingest([record("dispatch", { ticket: "42", author: "hermes" })]);

      expect(await exists("42-sess-1.md")).toBe(true);
      const digest = await read("42-sess-1.md");
      expect(digest).toContain("status: running");
      expect(digest).toContain("agent: claude");
      expect(digest).toContain("started_by: hermes");
      expect(digest).toContain("johan_touched: false");
      expect(await read("INDEX.md")).toContain(
        "- 42-sess-1.md — agent=claude ticket=42 status=running started_by=hermes johan_touched=false — session started",
      );
      expect(requests).toHaveLength(0);
    });
  });

  test("a takeover record flips johan_touched immediately", async () => {
    await withWorld(async ({ open, read }) => {
      const eye = await open(scriptedBrain([verdict([])]).brain);
      await eye.ingest([record("dispatch", { ticket: "42", author: "hermes" })]);
      await eye.ingest([
        record("do the auth fix first", {
          ticket: "42",
          author: "johan",
          johanTouched: true,
        }),
      ]);
      expect(await read("42-sess-1.md")).toContain("johan_touched: true");
      expect(await read("INDEX.md")).toContain("johan_touched=true");
    });
  });

  test("session-end / blocked / dead lifecycle events flip status mechanically", async () => {
    await withWorld(async ({ open, read }) => {
      const { brain, requests } = scriptedBrain([verdict([])]);
      const eye = await open(brain);
      await eye.ingest([record("dispatch", { ticket: "42", author: "hermes" })]);

      await eye.ingestLifecycle({
        kind: "session-blocked",
        sessionId: "sess-1",
        ts: "2026-08-24T12:05:00.000Z",
      });
      expect(await read("42-sess-1.md")).toContain("status: blocked");
      expect(await read("INDEX.md")).toContain("status=blocked");

      await eye.ingestLifecycle({
        kind: "session-end",
        sessionId: "sess-1",
        ts: "2026-08-24T12:06:00.000Z",
      });
      expect(await read("42-sess-1.md")).toContain("status: done");

      await eye.ingestLifecycle({
        kind: "session-dead",
        sessionId: "sess-1",
        ts: "2026-08-24T12:07:00.000Z",
      });
      expect(await read("42-sess-1.md")).toContain("status: dead");
      expect(await read("INDEX.md")).toContain("status=dead");
      expect(requests).toHaveLength(0);
    });
  });

  test("a session-start lifecycle event registers an adhoc session before any turn", async () => {
    await withWorld(async ({ open, read, exists }) => {
      const eye = await open(scriptedBrain([verdict([])]).brain);
      await eye.ingestLifecycle({
        kind: "session-start",
        sessionId: "sess-adhoc",
        ts: "2026-08-24T12:00:00.000Z",
      });
      expect(await exists("adhoc-sess-adhoc.md")).toBe(true);
      expect(await read("adhoc-sess-adhoc.md")).toContain("started_by: johan");
      expect(await read("INDEX.md")).toContain("ticket=null");
    });
  });
});
