import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StuckAlert } from "../backpressure";
import type { Brain } from "../brain";
import { createBrainCap } from "../cap";
import type { CuratorConfig } from "../config";
import { ReviewerEye, type MessageEvent, type ProvenanceRecord } from "../reviewer/reviewer";
import { readCuratorState } from "./state";
import { emptyRecord, readUsage, updateUsage } from "./usage";

const CADENCE = { quietWindowSeconds: 30, maxWaitSeconds: 300 };
const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const CURATOR: CuratorConfig = {
  enabled: true,
  intervalHours: 168,
  staleAfterDays: 30,
  archiveAfterDays: 90,
};

function record(uuid: string, author: ProvenanceRecord["author"], text: string): ProvenanceRecord {
  const event: MessageEvent = {
    type: "message",
    sessionId: "sess-1",
    role: author === "agent" ? "assistant" : "user",
    text,
    ts: new Date(NOW).toISOString(),
    uuid,
    candidate: author !== "agent",
    file: "/transcripts/sess-1.jsonl",
  };
  return {
    sessionId: "sess-1",
    author,
    via: author === "johan" ? "takeover" : "assistant",
    registered: true,
    startedBy: "hermes",
    johanTouched: author === "johan",
    ts: event.ts,
    text,
    event,
  };
}

const procedure = (uuid: string, slug: string) => ({
  kind: "procedure",
  slug,
  title: slug,
  content: `do the ${slug} thing`,
  sources: [uuid],
});

interface World {
  repo: string;
  root: string;
  skillsDir: string;
  alerts: StuckAlert[];
  clock: { now: () => number; set: (ms: number) => void };
  open: (brain: Brain, curator?: CuratorConfig) => Promise<ReviewerEye>;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-curator-trigger-"));
  const repo = join(root, "repo");
  let nowMs = NOW;
  const alerts: StuckAlert[] = [];
  try {
    await mkdir(join(repo, ".argus/skills"), { recursive: true });
    await body({
      repo,
      root,
      skillsDir: join(repo, ".argus/skills"),
      alerts,
      clock: {
        now: () => nowMs,
        set: (ms) => {
          nowMs = ms;
        },
      },
      open: (brain, curator = CURATOR) =>
        ReviewerEye.open({
          repo,
          brain,
          cap: createBrainCap({
            directory: join(root, "slots"),
            maxConcurrency: 2,
            pollMs: 1,
          }),
          cadence: CADENCE,
          curator,
          now: () => nowMs,
          sleep: async () => {},
          onAlert: (alert) => {
            alerts.push(alert);
          },
        }),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

/** A brain that answers the Reviewer, then the curator, then repeats. */
function twoTierBrain(reviewer: string, curator: string): Brain & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async evaluate({ prompt }) {
      prompts.push(prompt);
      return {
        ok: true,
        text: prompt.startsWith("You are the Argus curator") ? curator : reviewer,
      };
    },
  };
}

const QUIET_CURATOR = JSON.stringify({
  summary: "nothing to consolidate",
  consolidations: [],
  prunings: [],
  memory: { merges: [], prunings: [] },
});

async function plantStaleSkill(world: World, name: string): Promise<void> {
  await mkdir(join(world.skillsDir, name), { recursive: true });
  await Bun.write(
    join(world.skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n\nold\n`,
  );
  await updateUsage(world.skillsDir, (sidecar) => {
    sidecar[name] = {
      ...emptyRecord(new Date(NOW - 200 * DAY).toISOString()),
      last_used_at: new Date(NOW - 97 * DAY).toISOString(),
    };
  });
}

const exists = (path: string): Promise<boolean> => Bun.file(path).exists();

describe("the curator rides the Reviewer loop (SPEC §5.1 — a pass, not a sixth eye)", () => {
  test("the Reviewer's first evaluation only seeds the gate; nothing is curated", async () => {
    await withWorld(async (world) => {
      await plantStaleSkill(world, "legacy-deploy-dance");
      const brain = twoTierBrain(JSON.stringify({ findings: [] }), QUIET_CURATOR);
      const eye = await world.open(brain);

      await eye.ingest([record("uuid-1", "agent", "some turn")]);
      world.clock.set(NOW + CADENCE.maxWaitSeconds * 1_000 + 1_000);
      expect(await eye.tick()).toBe(true);

      expect(await exists(join(world.skillsDir, "legacy-deploy-dance/SKILL.md"))).toBe(true);
      expect((await readCuratorState(world.repo)).last_run_at).not.toBeNull();
      expect(brain.prompts.filter((p) => p.startsWith("You are the Argus curator"))).toEqual(
        [],
      );
    });
  });

  test("a week of turns later, the same loop curates the stale skill out", async () => {
    await withWorld(async (world) => {
      await plantStaleSkill(world, "legacy-deploy-dance");
      const brain = twoTierBrain(JSON.stringify({ findings: [] }), QUIET_CURATOR);
      const eye = await world.open(brain);

      await eye.ingest([record("uuid-1", "agent", "turn one")]);
      world.clock.set(NOW + CADENCE.maxWaitSeconds * 1_000 + 1_000);
      await eye.tick();

      world.clock.set(NOW + WEEK);
      await eye.ingest([record("uuid-2", "agent", "turn two")]);
      world.clock.set(NOW + WEEK + CADENCE.maxWaitSeconds * 1_000 + 1_000);
      expect(await eye.tick()).toBe(true);

      expect(await exists(join(world.skillsDir, "legacy-deploy-dance/SKILL.md"))).toBe(false);
      expect(
        await exists(join(world.skillsDir, ".archive/legacy-deploy-dance/SKILL.md")),
      ).toBe(true);
      expect((await readCuratorState(world.repo)).run_count).toBe(1);
    });
  });

  test("no curator config means no curator — an eye opened without it is unchanged", async () => {
    await withWorld(async (world) => {
      await plantStaleSkill(world, "legacy-deploy-dance");
      const brain = twoTierBrain(JSON.stringify({ findings: [] }), QUIET_CURATOR);
      const eye = await ReviewerEye.open({
        repo: world.repo,
        brain,
        cap: createBrainCap({
          directory: join(world.root, "slots"),
          maxConcurrency: 2,
          pollMs: 1,
        }),
        cadence: CADENCE,
        now: world.clock.now,
        sleep: async () => {},
        onAlert: () => {},
      });

      await eye.ingest([record("uuid-1", "agent", "turn")]);
      world.clock.set(NOW + WEEK);
      await eye.tick();

      expect(await exists(join(world.repo, ".argus/curator_state.json"))).toBe(false);
      expect(await exists(join(world.skillsDir, "legacy-deploy-dance/SKILL.md"))).toBe(true);
    });
  });
});

describe("the Reviewer is the curator's telemetry source (research #16 §7)", () => {
  test("writing a skill records it in the sidecar, so the clock starts on first sight", async () => {
    await withWorld(async (world) => {
      const brain = twoTierBrain(
        JSON.stringify({ findings: [procedure("uuid-1", "rotate-staging-cert")] }),
        QUIET_CURATOR,
      );
      const eye = await world.open(brain);

      await eye.ingest([record("uuid-1", "agent", "a novel procedure")]);
      world.clock.set(NOW + CADENCE.maxWaitSeconds * 1_000 + 1_000);
      await eye.tick();

      const usage = await readUsage(world.skillsDir);
      expect(usage["rotate-staging-cert"]!.created_by).toBe("agent");
      expect(usage["rotate-staging-cert"]!.created_at).toBe(
        new Date(NOW + CADENCE.maxWaitSeconds * 1_000 + 1_000).toISOString(),
      );
      expect(usage["rotate-staging-cert"]!.pinned).toBe(false);
    });
  });

  test("a skill Johan asked for is recorded as his, and pinned out of the curator's reach", async () => {
    await withWorld(async (world) => {
      const brain = twoTierBrain(
        JSON.stringify({ findings: [procedure("uuid-johan", "johans-ritual")] }),
        QUIET_CURATOR,
      );
      const eye = await world.open(brain);

      await eye.ingest([record("uuid-johan", "johan", "always do it this way")]);
      world.clock.set(NOW + CADENCE.maxWaitSeconds * 1_000 + 1_000);
      await eye.tick();

      const usage = await readUsage(world.skillsDir);
      expect(usage["johans-ritual"]!.created_by).toBe("johan");
      expect(usage["johans-ritual"]!.pinned).toBe(true);
    });
  });
});

describe("the curator can never take the Reviewer down", () => {
  test("a pass that blows up is alerted, and the evaluation still counts", async () => {
    await withWorld(async (world) => {
      // A file where the skills directory should be: every store write throws.
      await rm(world.skillsDir, { force: true, recursive: true });
      await Bun.write(world.skillsDir, "not a directory\n");
      const brain = twoTierBrain(JSON.stringify({ findings: [] }), QUIET_CURATOR);
      const eye = await world.open(brain);

      await eye.ingest([record("uuid-1", "agent", "turn one")]);
      world.clock.set(NOW + CADENCE.maxWaitSeconds * 1_000 + 1_000);
      await eye.tick();
      world.clock.set(NOW + WEEK);
      await eye.ingest([record("uuid-2", "agent", "turn two")]);
      world.clock.set(NOW + WEEK + CADENCE.maxWaitSeconds * 1_000 + 1_000);

      expect(await eye.tick()).toBe(true);
      expect(world.alerts.map(({ eye: name }) => name)).toContain("curator");
      expect(eye.pendingCount()).toBe(0);
    });
  });
});
