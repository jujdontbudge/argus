import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brain } from "../brain";
import { createBrainCap } from "../cap";
import { maybeRunCurator, runCuratorPass } from "./curator";
import { readCuratorState } from "./state";
import { emptyRecord, readUsage, updateUsage, type UsageRecord } from "./usage";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

interface World {
  repo: string;
  root: string;
  skillsDir: string;
  memoryDir: string;
  cap: ReturnType<typeof createBrainCap>;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-curator-pass-"));
  try {
    const repo = join(root, "repo");
    const world: World = {
      repo,
      root,
      skillsDir: join(repo, ".argus/skills"),
      memoryDir: join(repo, ".argus/memory"),
      cap: createBrainCap({
        directory: join(root, "slots"),
        maxConcurrency: 2,
        pollMs: 1,
      }),
    };
    await mkdir(world.skillsDir, { recursive: true });
    await mkdir(world.memoryDir, { recursive: true });
    await body(world);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function plantSkill(
  world: World,
  name: string,
  options: { body?: string; record?: Partial<UsageRecord> | null } = {},
): Promise<void> {
  await mkdir(join(world.skillsDir, name), { recursive: true });
  await Bun.write(
    join(world.skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n\n${options.body ?? name}\n`,
  );
  if (options.record === null) return;
  await updateUsage(world.skillsDir, (sidecar) => {
    sidecar[name] = { ...emptyRecord(iso(365)), ...options.record };
  });
}

async function plantFact(
  world: World,
  slug: string,
  title: string,
  body: string,
): Promise<void> {
  await Bun.write(
    join(world.memoryDir, `${slug}.md`),
    `---\nname: ${slug}\ndescription: ${title}\nmetadata:\n  type: project\n---\n\n${body}\n`,
  );
}

const QUIET = JSON.stringify({
  summary: "nothing worth consolidating",
  consolidations: [],
  prunings: [],
  memory: { merges: [], prunings: [] },
});

function stubBrain(text: string | (() => string)): Brain & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async evaluate({ prompt }) {
      prompts.push(prompt);
      return { ok: true, text: typeof text === "function" ? text() : text };
    },
  };
}

const pass = (world: World, brain: Brain, overrides: Record<string, unknown> = {}) =>
  runCuratorPass({ repo: world.repo, brain, cap: world.cap, now: NOW, ...overrides });

const exists = (path: string): Promise<boolean> => Bun.file(path).exists();

describe("the curator pass — the deterministic tier", () => {
  test("a stale skill is archived and an active one is untouched", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "legacy-deploy-dance", {
        record: { last_used_at: iso(97) },
      });
      await plantSkill(world, "rotate-staging-cert", {
        record: { last_used_at: iso(1) },
      });

      const result = await pass(world, stubBrain(QUIET));

      expect(await exists(join(world.skillsDir, "legacy-deploy-dance/SKILL.md"))).toBe(
        false,
      );
      expect(
        await exists(join(world.skillsDir, ".archive/legacy-deploy-dance/SKILL.md")),
      ).toBe(true);
      expect(await exists(join(world.skillsDir, "rotate-staging-cert/SKILL.md"))).toBe(
        true,
      );
      const usage = await readUsage(world.skillsDir);
      expect(usage["legacy-deploy-dance"]!.state).toBe("archived");
      expect(usage["rotate-staging-cert"]!.state).toBe("active");
      expect(result.report.archived.skills.map(({ name }) => name)).toEqual([
        "legacy-deploy-dance",
      ]);
    });
  });

  test("a skill seen for the first time is seeded, never archived on sight", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "never-seen-before", { record: null });

      await pass(world, stubBrain(QUIET));

      expect(await exists(join(world.skillsDir, "never-seen-before/SKILL.md"))).toBe(true);
      expect((await readUsage(world.skillsDir))["never-seen-before"]!.created_at).toBe(
        new Date(NOW).toISOString(),
      );
    });
  });

  test("a pinned skill survives however ancient", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "johans-ritual", {
        record: { pinned: true, created_by: "johan", last_used_at: iso(400) },
      });

      await pass(world, stubBrain(QUIET));

      expect(await exists(join(world.skillsDir, "johans-ritual/SKILL.md"))).toBe(true);
    });
  });

  test("a pinned skill is never even shown to the brain", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "johans-ritual", { record: { pinned: true } });
      await plantSkill(world, "ordinary", { record: { last_used_at: iso(1) } });

      const brain = stubBrain(QUIET);
      await pass(world, brain);

      expect(brain.prompts[0]).toContain("ordinary");
      expect(brain.prompts[0]).not.toContain("johans-ritual");
    });
  });

  test("a dry run judges but moves nothing, and says so in its report", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "legacy-deploy-dance", {
        record: { last_used_at: iso(97) },
      });

      const result = await pass(world, stubBrain(QUIET), { dryRun: true });

      expect(await exists(join(world.skillsDir, "legacy-deploy-dance/SKILL.md"))).toBe(
        true,
      );
      expect((await readUsage(world.skillsDir))["legacy-deploy-dance"]!.state).toBe(
        "active",
      );
      expect(result.report.dry_run).toBe(true);
      expect(result.report.archived.skills.map(({ name }) => name)).toEqual([
        "legacy-deploy-dance",
      ]);
      expect(await exists(join(result.reportDirectory, "REPORT.md"))).toBe(true);
    });
  });
});

describe("the curator pass — the consolidation tier", () => {
  test("a proposed consolidation rewrites the umbrella and archives the sibling", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "deploy", { record: { last_used_at: iso(1) } });
      await plantSkill(world, "deploy-staging", { record: { last_used_at: iso(2) } });

      await pass(
        world,
        stubBrain(
          JSON.stringify({
            summary: "one umbrella, two subsections",
            consolidations: [
              {
                from: "deploy-staging",
                into: "deploy",
                reason: "one skill with two labeled subsections",
                body: "# Deploy\n\n## Production\n\n## Staging\n",
              },
            ],
            prunings: [],
            memory: { merges: [], prunings: [] },
          }),
        ),
      );

      expect(await Bun.file(join(world.skillsDir, "deploy/SKILL.md")).text()).toContain(
        "## Staging",
      );
      expect(
        await exists(join(world.skillsDir, ".archive/deploy-staging/SKILL.md")),
      ).toBe(true);
      expect((await readUsage(world.skillsDir))["deploy-staging"]!.absorbed_into).toBe(
        "deploy",
      );
    });
  });

  test("a proposal naming a skill that does not exist is rejected, loudly", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "deploy", { record: { last_used_at: iso(1) } });

      const result = await pass(
        world,
        stubBrain(
          JSON.stringify({
            summary: "hallucinated",
            consolidations: [{ from: "deploy", into: "nowhere", reason: "r" }],
            prunings: [{ name: "also-nowhere", reason: "r" }],
            memory: { merges: [], prunings: [] },
          }),
        ),
      );

      expect(await exists(join(world.skillsDir, "deploy/SKILL.md"))).toBe(true);
      expect(result.report.llm.rejected.map(({ reason }) => reason).join(" ")).toContain(
        "unknown skill",
      );
      expect(result.report.archived.skills).toEqual([]);
    });
  });

  test("a proposal naming a pinned skill is rejected — the bypass is not advisory", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "johans-ritual", { record: { pinned: true } });
      // A live skill so the brain is woken at all; it names the pinned one anyway.
      await plantSkill(world, "ordinary", { record: { last_used_at: iso(1) } });

      const result = await pass(
        world,
        stubBrain(
          JSON.stringify({
            summary: "prune it",
            consolidations: [],
            prunings: [{ name: "johans-ritual", reason: "unused" }],
            memory: { merges: [], prunings: [] },
          }),
        ),
      );

      expect(await exists(join(world.skillsDir, "johans-ritual/SKILL.md"))).toBe(true);
      expect(result.report.llm.rejected[0]!.reason).toContain("pinned");
    });
  });

  test("a brain that fails does not sink the pass — the deterministic tier still lands", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "legacy-deploy-dance", {
        record: { last_used_at: iso(97) },
      });
      await plantSkill(world, "still-in-use", { record: { last_used_at: iso(1) } });
      const brokenBrain: Brain = {
        async evaluate() {
          return { ok: false, reason: "nonzero-exit", detail: "codex exploded" };
        },
      };

      const result = await pass(world, brokenBrain);

      expect(
        await exists(join(world.skillsDir, ".archive/legacy-deploy-dance/SKILL.md")),
      ).toBe(true);
      expect(result.report.errors.join(" ")).toContain("codex exploded");
      expect(result.report.llm.ran).toBe(false);
    });
  });

  test("a schema-miss verdict is an error, not a silent no-op", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "deploy", { record: { last_used_at: iso(1) } });
      const result = await pass(world, stubBrain("I decided to think out loud instead"));
      expect(result.report.errors.join(" ")).toContain("schema miss");
    });
  });

  test("with no candidates at all the brain is never woken", async () => {
    await withWorld(async (world) => {
      const brain = stubBrain(QUIET);
      const result = await pass(world, brain);
      expect(brain.prompts).toEqual([]);
      expect(result.report.llm.ran).toBe(false);
    });
  });
});

describe("the curator pass — the memory half", () => {
  test("a proposed merge archives the duplicate fact and de-indexes it", async () => {
    await withWorld(async (world) => {
      await plantFact(world, "metro-port", "Metro port", "Metro runs on 8082.");
      await plantFact(world, "metro-8082", "Metro on 8082", "Metro is on 8082.");
      await Bun.write(
        join(world.memoryDir, "MEMORY.md"),
        [
          "# Memory index",
          "",
          "- [Metro port](metro-port.md) — Metro runs on 8082.",
          "- [Metro on 8082](metro-8082.md) — Metro is on 8082.",
          "",
        ].join("\n"),
      );

      const result = await pass(
        world,
        stubBrain(
          JSON.stringify({
            summary: "same fact twice",
            consolidations: [],
            prunings: [],
            memory: {
              merges: [
                { from: "metro-8082", into: "metro-port", reason: "duplicate fact" },
              ],
              prunings: [],
            },
          }),
        ),
      );

      expect(await exists(join(world.memoryDir, "metro-8082.md"))).toBe(false);
      expect(await exists(join(world.memoryDir, ".archive/metro-8082.md"))).toBe(true);
      expect(await exists(join(world.memoryDir, "metro-port.md"))).toBe(true);
      const index = await Bun.file(join(world.memoryDir, "MEMORY.md")).text();
      expect(index).not.toContain("metro-8082.md");
      expect(index).toContain("metro-port.md");
      expect(result.report.archived.facts.map(({ slug }) => slug)).toEqual(["metro-8082"]);
    });
  });

  test("an untouched-for-a-year fact is never archived by the clock alone", async () => {
    await withWorld(async (world) => {
      await plantFact(world, "metro-port", "Metro port", "Metro runs on 8082.");
      await pass(world, stubBrain(QUIET));
      expect(await exists(join(world.memoryDir, "metro-port.md"))).toBe(true);
    });
  });

  test("index/fact-file orphans are reported and repaired, both directions", async () => {
    await withWorld(async (world) => {
      await plantFact(world, "unlisted", "Unlisted fact", "nobody indexed me");
      await Bun.write(
        join(world.memoryDir, "MEMORY.md"),
        "# Memory index\n\n- [Ghost](ghost.md) — its file is gone\n",
      );

      const result = await pass(world, stubBrain(QUIET));

      expect(result.report.orphans).toEqual([
        { kind: "file-without-index", slug: "unlisted" },
        { kind: "index-without-file", slug: "ghost" },
      ]);
      const index = await Bun.file(join(world.memoryDir, "MEMORY.md")).text();
      expect(index).toContain("unlisted.md");
      expect(index).not.toContain("ghost.md");
    });
  });

  test("a proposed pruning of an index orphan is rejected, and the index still converges", async () => {
    // The verdict body below is what the real luna brain returned on the #91
    // live run, verbatim in shape: handed an `index-without-file` orphan and
    // no schema field for it, it filed `ghost` under memory prunings. The eye
    // must treat that as a name that does not exist — never as a fact to
    // archive — and repair the index on its own account regardless.
    await withWorld(async (world) => {
      await plantFact(world, "metro-port", "Metro port", "Metro runs on 8082.");
      await Bun.write(
        join(world.memoryDir, "MEMORY.md"),
        [
          "# Memory index",
          "",
          "- [Metro port](metro-port.md) — Metro runs on 8082.",
          "- [Ghost](ghost.md) — its file is gone",
          "",
        ].join("\n"),
      );

      const result = await pass(
        world,
        stubBrain(
          JSON.stringify({
            summary: "remove the orphaned index entry",
            consolidations: [],
            prunings: [],
            memory: {
              merges: [],
              prunings: [
                {
                  slug: "ghost",
                  reason: "the index references a fact file that does not exist",
                },
              ],
            },
          }),
        ),
      );

      expect(result.report.llm.rejected).toEqual([
        { what: "memory pruning ghost", reason: "unknown fact: ghost" },
      ]);
      expect(result.report.archived.facts).toEqual([]);
      expect(await exists(join(world.memoryDir, "metro-port.md"))).toBe(true);
      const index = await Bun.file(join(world.memoryDir, "MEMORY.md")).text();
      expect(index).toContain("metro-port.md");
      expect(index).not.toContain("ghost.md");
    });
  });

  test("a dry run reports orphans without repairing them", async () => {
    await withWorld(async (world) => {
      await plantFact(world, "unlisted", "Unlisted fact", "nobody indexed me");
      await Bun.write(join(world.memoryDir, "MEMORY.md"), "# Memory index\n");

      const result = await pass(world, stubBrain(QUIET), { dryRun: true });

      expect(result.report.orphans).toEqual([
        { kind: "file-without-index", slug: "unlisted" },
      ]);
      expect(await Bun.file(join(world.memoryDir, "MEMORY.md")).text()).toBe(
        "# Memory index\n",
      );
    });
  });
});

describe("the Reviewer's trigger point", () => {
  const trigger = (world: World, brain: Brain, overrides: Record<string, unknown> = {}) =>
    maybeRunCurator({
      repo: world.repo,
      brain,
      cap: world.cap,
      now: NOW,
      config: { enabled: true, intervalHours: 168, staleAfterDays: 30, archiveAfterDays: 90 },
      ...overrides,
    });

  test("the first opportunity seeds the gate and defers — no pass, no brain call", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "legacy-deploy-dance", { record: { last_used_at: iso(97) } });
      const brain = stubBrain(QUIET);

      const decision = await trigger(world, brain);

      expect(decision.ran).toBe(false);
      expect(decision.reason).toBe("seeded-deferred");
      expect(brain.prompts).toEqual([]);
      expect(await exists(join(world.skillsDir, "legacy-deploy-dance/SKILL.md"))).toBe(true);
    });
  });

  test("a week later it runs, and the gate records the run", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "legacy-deploy-dance", { record: { last_used_at: iso(97) } });
      const brain = stubBrain(QUIET);
      await trigger(world, brain);

      const decision = await trigger(world, brain, { now: NOW + WEEK });

      expect(decision.ran).toBe(true);
      expect(
        await exists(join(world.skillsDir, ".archive/legacy-deploy-dance/SKILL.md")),
      ).toBe(true);
      const state = await readCuratorState(world.repo);
      expect(state.run_count).toBe(1);
      expect(state.last_run_at).toBe(new Date(NOW + WEEK).toISOString());
      expect(state.last_report_path).toContain(".argus/reports/curator/");
    });
  });

  test("a dry run NEVER bumps the gate", async () => {
    await withWorld(async (world) => {
      await plantSkill(world, "legacy-deploy-dance", { record: { last_used_at: iso(97) } });
      await trigger(world, stubBrain(QUIET));
      const seeded = await readCuratorState(world.repo);

      const decision = await trigger(world, stubBrain(QUIET), {
        now: NOW + WEEK,
        dryRun: true,
      });

      expect(decision.ran).toBe(true);
      const after = await readCuratorState(world.repo);
      expect(after.last_run_at).toBe(seeded.last_run_at);
      expect(after.run_count).toBe(0);
    });
  });

  test("a disabled curator does nothing at all, and leaves no state behind", async () => {
    await withWorld(async (world) => {
      const brain = stubBrain(QUIET);
      const decision = await trigger(world, brain, {
        config: {
          enabled: false,
          intervalHours: 168,
          staleAfterDays: 30,
          archiveAfterDays: 90,
        },
      });
      expect(decision.ran).toBe(false);
      expect(decision.reason).toBe("disabled");
      expect(await exists(join(world.repo, ".argus/curator_state.json"))).toBe(false);
    });
  });
});
