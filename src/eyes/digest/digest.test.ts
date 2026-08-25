import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvenanceRecord, SessionRecord } from "../../provenance";
import type { MessageEvent } from "../../tailing";
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

describe("the coalesced brain path (ADR-0002: 30s quiet / 120s max)", () => {
  test("the quiet window elapsing fires one evaluation; narrative and summary land", async () => {
    await withWorld(async ({ open, clock, read }) => {
      const { brain, requests } = scriptedBrain([
        verdict([
          {
            sessionId: "sess-1",
            narrative: "Diagnosed the tailer rotation bug; fix in progress.",
            summary: "rotation bug diagnosed",
            status: "running",
          },
        ]),
      ]);
      const eye = await open(brain);
      await eye.ingest([record("dispatch", { ticket: "42", author: "hermes" })]);
      expect(await eye.tick()).toBe(false);

      clock.set(CADENCE.quietWindowSeconds * SECOND + 1);
      expect(await eye.tick()).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.prompt).toContain("session=sess-1");
      const digest = await read("42-sess-1.md");
      expect(digest).toContain("Diagnosed the tailer rotation bug");
      expect(await read("INDEX.md")).toContain("— rotation bug diagnosed");
      expect(eye.pendingCount()).toBe(0);
    });
  });

  test("a busy session cannot starve evaluation past maxWait", async () => {
    await withWorld(async ({ open, clock }) => {
      const eye = await open(scriptedBrain([verdict([])]).brain);
      for (let i = 0; i < 8; i++) {
        clock.set(i * 20 * SECOND);
        await eye.ingest([
          record(`turn ${i}`, { ticket: "42", ts: new Date(i * 20 * SECOND).toISOString() }),
        ]);
      }
      expect(eye.dueAt()).toBe(CADENCE.maxWaitSeconds * SECOND);
    });
  });

  test("a lifecycle event makes pending narrative due immediately", async () => {
    await withWorld(async ({ open, clock, read }) => {
      const { brain, requests } = scriptedBrain([
        verdict([
          {
            sessionId: "sess-1",
            narrative: "Wrapped up: tests green, committed.",
            summary: "finished",
            status: "done",
          },
        ]),
      ]);
      const eye = await open(brain);
      await eye.ingest([record("almost done", { ticket: "42" })]);
      clock.set(5 * SECOND); // well inside the quiet window
      expect(await eye.tick()).toBe(false);

      await eye.ingestLifecycle({
        kind: "session-end",
        sessionId: "sess-1",
        ts: "2026-08-24T12:09:00.000Z",
      });
      expect(await eye.tick()).toBe(true);
      expect(requests).toHaveLength(1);
      const digest = await read("42-sess-1.md");
      expect(digest).toContain("Wrapped up: tests green, committed.");
      expect(digest).toContain("status: done");
    });
  });

  test("no-skip: pending turns survive a restart and evaluate after it", async () => {
    await withWorld(async ({ open, clock, read }) => {
      const first = await open(scriptedBrain([verdict([])]).brain);
      await first.ingest([record("progress report", { ticket: "42" })]);

      const { brain, requests } = scriptedBrain([
        verdict([
          {
            sessionId: "sess-1",
            narrative: "Progress recorded after restart.",
            summary: "progressing",
            status: "running",
          },
        ]),
      ]);
      const reopened = await open(brain);
      expect(reopened.pendingCount()).toBe(1);
      clock.set(CADENCE.maxWaitSeconds * SECOND + 1);
      expect(await reopened.tick()).toBe(true);
      expect(requests).toHaveLength(1);
      expect(await read("42-sess-1.md")).toContain("Progress recorded after restart.");
    });
  });

  test("a brain failure retries — the batch is never dropped", async () => {
    await withWorld(async ({ open, clock, read }) => {
      let attempts = 0;
      const brain: Brain = {
        async evaluate() {
          attempts += 1;
          if (attempts < 3) return { ok: false, reason: "nonzero-exit", detail: "boom" };
          return {
            ok: true,
            text: verdict([
              {
                sessionId: "sess-1",
                narrative: "Survived the flaky brain.",
                summary: "resilient",
                status: "running",
              },
            ]),
          };
        },
      };
      const eye = await open(brain, { baseDelayMs: 1, maxDelayMs: 2 });
      await eye.ingest([record("turn", { ticket: "42" })]);
      clock.set(CADENCE.maxWaitSeconds * SECOND + 1);
      expect(await eye.tick()).toBe(true);
      expect(attempts).toBe(3);
      expect(await read("42-sess-1.md")).toContain("Survived the flaky brain.");
    });
  });

  test("running→blocked→done from the brain, then dead from the supervisor", async () => {
    await withWorld(async ({ open, clock, read }) => {
      const { brain } = scriptedBrain([
        verdict([{ sessionId: "sess-1", status: "blocked", summary: "waiting on key" }]),
        verdict([{ sessionId: "sess-1", status: "done", summary: "shipped" }]),
        verdict([{ sessionId: "sess-1", status: "running", summary: "zombie?" }]),
      ]);
      const eye = await open(brain);
      await eye.ingest([record("need the key", { ticket: "42" })]);
      clock.set(CADENCE.maxWaitSeconds * SECOND + 1);
      await eye.tick();
      expect(await read("42-sess-1.md")).toContain("status: blocked");

      await eye.ingest([record("got it, done", { ticket: "42" })]);
      clock.set(2 * CADENCE.maxWaitSeconds * SECOND + 2);
      await eye.tick();
      expect(await read("42-sess-1.md")).toContain("status: done");

      await eye.ingestLifecycle({
        kind: "session-dead",
        sessionId: "sess-1",
        ts: "2026-08-24T13:00:00.000Z",
      });
      // A late brain verdict cannot resurrect a dead session.
      await eye.ingest([record("late echo", { ticket: "42" })]);
      clock.set(3 * CADENCE.maxWaitSeconds * SECOND + 3);
      await eye.tick();
      expect(await read("42-sess-1.md")).toContain("status: dead");
      expect(await read("INDEX.md")).toContain("status=dead");
    });
  });

  test("rotation: a compression continuation appends to the root's one digest", async () => {
    await withWorld(async ({ open, clock, read, exists }) => {
      const registrations: SessionRecord[] = [
        {
          ts: "2026-08-24T11:00:00.000Z",
          sessionId: "sess-a",
          dispatchPrompt: "work ticket 42",
          agent: "claude",
          ticket: "42",
        },
        {
          ts: "2026-08-24T11:30:00.000Z",
          sessionId: "sess-b",
          dispatchPrompt: "compressed continuation",
          agent: "claude",
          ticket: "42",
          continues: "sess-a",
        },
      ];
      const { brain, requests } = scriptedBrain([
        verdict([
          {
            sessionId: "sess-a",
            narrative: "Started the migration.",
            summary: "migrating",
            status: "running",
          },
        ]),
        verdict([
          {
            sessionId: "sess-a",
            narrative: "Continued after compression; migration finished.",
            summary: "migration finished",
            status: "done",
          },
        ]),
      ]);
      const eye = await open(brain, { sessions: async () => registrations });

      await eye.ingest([record("first phase", { sessionId: "sess-a", ticket: "42" })]);
      clock.set(CADENCE.maxWaitSeconds * SECOND + 1);
      await eye.tick();

      await eye.ingest([record("second phase", { sessionId: "sess-b", ticket: "42" })]);
      clock.set(2 * CADENCE.maxWaitSeconds * SECOND + 2);
      await eye.tick();

      // Both physical ids were presented to the brain as the ONE logical session.
      expect(requests[1]!.prompt).toContain("session=sess-a");
      expect(requests[1]!.prompt).not.toContain("session=sess-b");
      expect(await exists("42-sess-b.md")).toBe(false);
      const digest = await read("42-sess-a.md");
      expect(digest).toContain("Started the migration.");
      expect(digest).toContain("migration finished");
      const index = await read("INDEX.md");
      expect(index.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
      expect(index).toContain("42-sess-a.md");
    });
  });
});

describe("openDigest — the production composition", () => {
  test("binds .argus/config.yaml digest cadence and a substitutable brain", async () => {
    await withWorld(async ({ repo }) => {
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        ["digest:", "  quiet_window_seconds: 7", "  max_wait_seconds: 11", ""].join("\n"),
      );
      let nowMs = 0;
      const { brain, requests } = scriptedBrain([
        verdict([
          { sessionId: "sess-1", narrative: "Composed.", summary: "ok", status: "running" },
        ]),
      ]);
      const eye = await openDigest(repo, {
        brain,
        capDirectory: join(repo, ".argus/slots"),
        now: () => nowMs,
        sleep: async (ms) => void (nowMs += ms),
        onAlert: () => {},
      });
      await eye.ingest([record("turn", { ticket: "42" })]);
      expect(eye.dueAt()).toBe(7 * SECOND);
      nowMs = 12 * SECOND;
      expect(await eye.tick()).toBe(true);
      expect(requests).toHaveLength(1);
      expect(
        await Bun.file(join(repo, ".argus/sessions/42-sess-1.md")).text(),
      ).toContain("Composed.");
    });
  });
});
