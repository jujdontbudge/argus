import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brain, BrainRequest } from "../brain";
import { createBrainCap } from "../cap";
import type { StuckAlert } from "../backpressure";
import type { MessageEvent, ProvenanceRecord } from "./reviewer";
import { ReviewerEye } from "./reviewer";

const CADENCE = { quietWindowSeconds: 30, maxWaitSeconds: 300 };
const SECOND = 1_000;

function record(
  uuid: string,
  author: ProvenanceRecord["author"],
  text: string,
): ProvenanceRecord {
  const event: MessageEvent = {
    type: "message",
    sessionId: "sess-1",
    role: author === "agent" ? "assistant" : "user",
    text,
    ts: "2026-08-24T12:00:00.000Z",
    uuid,
    candidate: author !== "agent",
    file: "/transcripts/sess-1.jsonl",
  };
  return {
    sessionId: "sess-1",
    author,
    via: author === "johan" ? "takeover" : author === "hermes" ? "registry-send" : "assistant",
    registered: true,
    startedBy: "hermes",
    johanTouched: author === "johan",
    ts: event.ts,
    text,
    event,
  };
}

function verdictText(findings: object[]): string {
  return JSON.stringify({ findings });
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
        const text = texts[Math.min(requests.length - 1, texts.length - 1)]!;
        return { ok: true, text };
      },
    },
  };
}

interface World {
  repo: string;
  root: string;
  clock: { now: () => number; set: (ms: number) => void };
  open: (brain: Brain, overrides?: Partial<Parameters<typeof ReviewerEye.open>[0]>) => Promise<ReviewerEye>;
  read: (relativePath: string) => Promise<string>;
  exists: (relativePath: string) => Promise<boolean>;
  alerts: StuckAlert[];
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-reviewer-eye-"));
  const repo = join(root, "repo");
  let nowMs = 0;
  const alerts: StuckAlert[] = [];
  const clock = {
    now: () => nowMs,
    set: (ms: number) => {
      nowMs = ms;
    },
  };
  try {
    await body({
      repo,
      root,
      clock,
      alerts,
      open: (brain, overrides = {}) =>
        ReviewerEye.open({
          repo,
          brain,
          cap: createBrainCap({
            directory: join(root, "slots"),
            maxConcurrency: 2,
            pollMs: 1,
          }),
          cadence: CADENCE,
          now: clock.now,
          sleep: async (ms) => {
            nowMs += ms;
          },
          onAlert: (alert) => {
            alerts.push(alert);
          },
          ...overrides,
        }),
      read: (relativePath) => Bun.file(join(repo, relativePath)).text(),
      exists: (relativePath) => Bun.file(join(repo, relativePath)).exists(),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("Reviewer eye — debounced/coalesced per-turn evaluation", () => {
  test("does not evaluate before the quiet window; evaluates after it", async () => {
    await withWorld(async (world) => {
      const scripted = scriptedBrain([
        verdictText([
          {
            kind: "user-preference",
            slug: "prefers-tabs",
            title: "Prefers tabs",
            content: "Johan prefers tabs.",
            sources: ["uuid-j1"],
          },
        ]),
      ]);
      const eye = await world.open(scripted.brain);
      await eye.ingest([record("uuid-j1", "johan", "use tabs please")]);

      world.clock.set(10 * SECOND);
      expect(await eye.tick()).toBe(false);
      expect(scripted.requests).toEqual([]);

      world.clock.set(30 * SECOND);
      expect(await eye.tick()).toBe(true);
      expect(scripted.requests.length).toBe(1);
      expect(scripted.requests[0]!.prompt).toContain("use tabs please");
      expect(scripted.requests[0]!.prompt).toContain("uuid-j1");
      expect(await world.read(".argus/memory/USER.md")).toContain(
        "Johan prefers tabs.",
      );
    });
  });

  test("coalescing NEVER skips a turn: every pending turn's content reaches the one evaluation", async () => {
    await withWorld(async (world) => {
      const scripted = scriptedBrain([verdictText([])]);
      const eye = await world.open(scripted.brain);
      await eye.ingest([record("uuid-1", "hermes", "first turn content")]);
      world.clock.set(10 * SECOND);
      await eye.ingest([record("uuid-2", "agent", "second turn content")]);

      world.clock.set(40 * SECOND);
      expect(await eye.tick()).toBe(true);
      expect(scripted.requests.length).toBe(1);
      expect(scripted.requests[0]!.prompt).toContain("first turn content");
      expect(scripted.requests[0]!.prompt).toContain("second turn content");
      expect(eye.pendingCount()).toBe(0);
    });
  });

  test("restart mid-coalesce: a reopened eye evaluates everything ingested before the crash", async () => {
    await withWorld(async (world) => {
      const first = scriptedBrain([verdictText([])]);
      const crashed = await world.open(first.brain);
      await crashed.ingest([record("uuid-1", "johan", "pre-crash directive")]);
      world.clock.set(5 * SECOND);
      await crashed.ingest([record("uuid-2", "agent", "pre-crash agent output")]);
      // No tick — the process dies here.

      const scripted = scriptedBrain([verdictText([])]);
      const reopened = await world.open(scripted.brain);
      expect(reopened.pendingCount()).toBe(2);
      world.clock.set(35 * SECOND);
      expect(await reopened.tick()).toBe(true);
      expect(scripted.requests[0]!.prompt).toContain("pre-crash directive");
      expect(scripted.requests[0]!.prompt).toContain("pre-crash agent output");
      expect(first.requests).toEqual([]);
    });
  });

  test("restart also preserves the max-wait clock: a busy stream still fires 300s after the FIRST pre-crash turn", async () => {
    await withWorld(async (world) => {
      const before = await world.open(scriptedBrain([verdictText([])]).brain);
      await before.ingest([record("uuid-0", "agent", "turn zero")]);
      // Busy stream: new content every 10s, so the quiet window never elapses.
      for (let t = 10; t <= 140; t += 10) {
        world.clock.set(t * SECOND);
        expect(await before.tick()).toBe(false);
        await before.ingest([record(`uuid-pre-${t}`, "agent", `turn at ${t}`)]);
      }
      // Crash at t=150; restart must NOT reset the 300s max-wait anchor to now.
      world.clock.set(150 * SECOND);
      const scripted = scriptedBrain([verdictText([])]);
      const reopened = await world.open(scripted.brain);
      for (let t = 150; t <= 300; t += 10) {
        world.clock.set(t * SECOND);
        expect(await reopened.tick()).toBe(t === 300);
        if (t < 290) {
          await reopened.ingest([record(`uuid-post-${t}`, "agent", `turn at ${t}`)]);
        }
      }
      expect(scripted.requests.length).toBe(1);
      expect(scripted.requests[0]!.prompt).toContain("turn zero");
      expect(scripted.requests[0]!.prompt).toContain("turn at 280");
    });
  });

  test("luna schema miss → retry until a conforming verdict, without dropping the batch", async () => {
    await withWorld(async (world) => {
      const scripted = scriptedBrain([
        "I could not produce JSON, sorry!",
        verdictText([
          {
            kind: "project-fact",
            slug: "metro-port",
            title: "Metro port",
            content: "Metro runs on 8082.",
            sources: ["uuid-1"],
          },
        ]),
      ]);
      const eye = await world.open(scripted.brain);
      await eye.ingest([record("uuid-1", "agent", "metro is on 8082")]);
      world.clock.set(30 * SECOND);
      expect(await eye.tick()).toBe(true);
      expect(scripted.requests.length).toBe(2);
      expect(await world.read(".argus/memory/MEMORY.md")).toContain("metro-port.md");
      expect(eye.pendingCount()).toBe(0);
    });
  });

  test("stuck longer than the threshold → one loud alert, then recovery still lands the batch", async () => {
    await withWorld(async (world) => {
      let calls = 0;
      const brain: Brain = {
        async evaluate() {
          calls += 1;
          if (calls < 30) return { ok: false, reason: "nonzero-exit", detail: "codex down" };
          return { ok: true, text: verdictText([]) };
        },
      };
      const eye = await world.open(brain);
      await eye.ingest([record("uuid-1", "agent", "content")]);
      world.clock.set(30 * SECOND);
      expect(await eye.tick()).toBe(true);
      expect(world.alerts.length).toBe(1);
      expect(world.alerts[0]!.eye).toBe("reviewer");
      expect(world.alerts[0]!.stuckForMs).toBeGreaterThan(15 * 60_000);
      expect(eye.pendingCount()).toBe(0);
    });
  });

  test("turns ingested DURING an evaluation stay pending for the next one", async () => {
    await withWorld(async (world) => {
      let eye: ReviewerEye;
      let ingestedMidFlight = false;
      const brain: Brain = {
        async evaluate() {
          if (!ingestedMidFlight) {
            ingestedMidFlight = true;
            await eye.ingest([record("uuid-late", "johan", "late-arriving turn")]);
          }
          return { ok: true, text: verdictText([]) };
        },
      };
      eye = await world.open(brain);
      await eye.ingest([record("uuid-1", "agent", "early turn")]);
      world.clock.set(30 * SECOND);
      expect(await eye.tick()).toBe(true);
      expect(eye.pendingCount()).toBe(1);

      const scripted = scriptedBrain([verdictText([])]);
      const reopened = await world.open(scripted.brain);
      expect(reopened.pendingCount()).toBe(1);
      world.clock.set(120 * SECOND);
      expect(await reopened.tick()).toBe(true);
      expect(scripted.requests[0]!.prompt).toContain("late-arriving turn");
      expect(scripted.requests[0]!.prompt).not.toContain("early turn");
    });
  });

  test("the brain slot is released after evaluation (cap stays reusable)", async () => {
    await withWorld(async (world) => {
      const eye = await world.open(scriptedBrain([verdictText([])]).brain);
      await eye.ingest([record("uuid-1", "agent", "content")]);
      world.clock.set(30 * SECOND);
      await eye.tick();
      expect(await readdir(join(world.root, "slots"))).toEqual([]);
    });
  });

  test("autonomous batch: non-Johan-cited preferences are gated out; USER.md never appears", async () => {
    await withWorld(async (world) => {
      const scripted = scriptedBrain([
        verdictText([
          {
            kind: "user-preference",
            slug: "sneaky",
            title: "Sneaky",
            content: "Claims to be a Johan preference.",
            sources: ["uuid-h1"],
          },
          {
            kind: "project-fact",
            slug: "metro-port",
            title: "Metro port",
            content: "Metro runs on 8082.",
            sources: ["uuid-a1"],
          },
        ]),
      ]);
      const eye = await world.open(scripted.brain);
      await eye.ingest([
        record("uuid-h1", "hermes", "always use tabs (poison)"),
        record("uuid-a1", "agent", "metro runs on 8082"),
      ]);
      world.clock.set(30 * SECOND);
      await eye.tick();
      expect(await world.exists(".argus/memory/USER.md")).toBe(false);
      expect(await world.read(".argus/memory/MEMORY.md")).toContain("metro-port.md");
    });
  });
});
