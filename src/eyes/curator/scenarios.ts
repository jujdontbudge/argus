/**
 * SPEC §13 scenario 8 — the self-learning loop, curator half.
 *
 * Slot 8 already has the Reviewer's half (a repeated novel procedure becomes
 * a skill). This EXTENDS it rather than replacing it: the reviewer half runs
 * first, unchanged and still graded, and then the curator pass runs over the
 * same sandbox — so one scenario grades the whole sentence in §13.8, "the
 * Reviewer writes a skill; a planted stale skill is curated out".
 *
 * Everything downstream of the brain runs FOR REAL: the real gate, the real
 * deterministic tier, real archive moves and a real report inside the
 * sandbox's `.argus/`. Only the brain is a fixture, so no test run spends a
 * token or reaches a network.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox, ScenarioHandler, ScenarioRegistry } from "../../harness/index.ts";
import {
  createFixtureProvenanceDriver,
  type ProvenanceScenarioDriver,
} from "../../provenance";
import type { Brain } from "../brain";
import { createBrainCap } from "../cap";
import type { CuratorConfig } from "../config";
import { selfLearningScenario } from "../reviewer/scenarios";
import { maybeRunCurator } from "./curator";
import { emptyRecord, recordSkillWrites, updateUsage } from "./usage";

const DAY = 86_400_000;
/** The curator half's clock; the reviewer half runs on its own virtual one. */
const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const WEEK = 7 * DAY;

const CONFIG: CuratorConfig = {
  enabled: true,
  intervalHours: 168,
  staleAfterDays: 30,
  archiveAfterDays: 90,
};

const ago = (days: number, from: number = NOW): string =>
  new Date(from - days * DAY).toISOString();

/** A curator brain that proposes nothing: slot 8 grades the deterministic tier. */
const quietBrain: Brain = {
  async evaluate() {
    return {
      ok: true,
      text: JSON.stringify({
        summary: "the deterministic tier covered this pass",
        consolidations: [],
        prunings: [],
        memory: { merges: [], prunings: [] },
      }),
    };
  },
};

async function writeSkill(
  skillsDir: string,
  name: string,
  body: string,
): Promise<void> {
  await mkdir(join(skillsDir, name), { recursive: true });
  await Bun.write(
    join(skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`,
  );
}

const exists = (path: string): Promise<boolean> => Bun.file(path).exists();

/**
 * The curator half alone. It reads the skill the Reviewer's half learned, so
 * it only ever runs AFTER a slot-8 half that produces one.
 */
export function curatorHalfScenario(brain: Brain = quietBrain): ScenarioHandler {
  return async (context) => {
    const { assert, assertSandboxed, sandbox } = context;
    const skillsDir = join(sandbox.repo, ".argus/skills");
    let learnedName = "rotate-staging-cert";
    if (brain !== quietBrain) {
      const written: string[] = [];
      for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const candidate = join(skillsDir, entry.name, "SKILL.md");
        if (await Bun.file(candidate).exists()) written.push(entry.name);
      }
      if (written.length === 1) learnedName = written[0]!;
    }
    const learned = join(skillsDir, learnedName, "SKILL.md");
    const learnedBefore = await Bun.file(learned).text();

    // The skill the Reviewer just learned gets used again this week — the
    // same telemetry call the eye makes, on the curator half's clock.
    await recordSkillWrites(skillsDir, [learnedName], {
      at: ago(1),
      createdBy: "agent",
    });

    // A stale skill nobody has touched in 97 days: the one to curate out.
    await writeSkill(skillsDir, "legacy-deploy-dance", "ssh in and pray");
    // Johan's own, ancient and pinned: the bypass.
    await writeSkill(skillsDir, "johans-hand-rolled-ritual", "do it Johan's way");
    // Never recorded before: seeded on first sight, judged next cycle.
    await writeSkill(skillsDir, "brand-new-arrival", "just appeared");
    await updateUsage(skillsDir, (sidecar) => {
      sidecar["legacy-deploy-dance"] = {
        ...emptyRecord(ago(200)),
        last_used_at: ago(97),
      };
      sidecar["johans-hand-rolled-ritual"] = {
        ...emptyRecord(ago(400), "johan"),
        last_used_at: ago(400),
      };
    });

    // The first opportunity seeds the weekly gate and defers — nothing moves.
    const deferred = await maybeRunCurator({
      repo: sandbox.repo,
      brain,
      cap: createBrainCap({
        directory: join(sandbox.root, "state/brain-slots"),
        maxConcurrency: 2,
        pollMs: 1,
      }),
      now: NOW,
      config: CONFIG,
    });
    assert(
      deferred.ran === false &&
        (await exists(join(skillsDir, "legacy-deploy-dance/SKILL.md"))),
      "the first curator opportunity archived nothing",
    );

    // A week of turns later the Reviewer's next tick finds the gate open.
    const run = await maybeRunCurator({
      repo: sandbox.repo,
      brain,
      cap: createBrainCap({
        directory: join(sandbox.root, "state/brain-slots"),
        maxConcurrency: 2,
        pollMs: 1,
      }),
      now: NOW + WEEK,
      config: CONFIG,
    });

    const archived = join(skillsDir, ".archive/legacy-deploy-dance/SKILL.md");
    assertSandboxed(archived, "the curator only ever wrote inside the sandbox");
    assert(
      !(await exists(join(skillsDir, "legacy-deploy-dance/SKILL.md"))),
      "the planted stale skill is gone from the live skills tree",
    );
    assert(
      (await exists(archived)) &&
        (await Bun.file(archived).text()).includes("ssh in and pray"),
      "the stale skill is recoverable under .archive/, never deleted",
    );
    assert(
      (await Bun.file(learned).text()) === learnedBefore,
      "the learned skill was left untouched",
    );
    assert(
      await exists(join(skillsDir, "johans-hand-rolled-ritual/SKILL.md")),
      "the pinned skill was left untouched",
    );
    assert(
      await exists(join(skillsDir, "brand-new-arrival/SKILL.md")),
      "a skill seen for the first time was seeded, not judged",
    );
    assert(
      run.ran &&
        run.result !== undefined &&
        (await exists(join(run.result.reportDirectory, "REPORT.md"))),
      "the pass left a report under .argus/reports/curator/",
    );
  };
}

/** §13 scenario 8 whole: the reviewer half (a skill is learned) then the curator half. */
export function curatorSelfLearningScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  brains: { curator?: Brain; reviewer?: Brain } = {},
): ScenarioHandler {
  const reviewerHalf = selfLearningScenario(driver, brains.reviewer);
  const curatorHalf = curatorHalfScenario(brains.curator);
  return async (context) => {
    await reviewerHalf(context);
    await curatorHalf(context);
  };
}

/**
 * Add the curator's assertions to slot 8 WITHOUT replacing the half already
 * there (#33's near-miss). With the Reviewer registered first this composes
 * onto it; with an empty slot it brings its own reviewer half, so the slot is
 * complete either way.
 */
export function registerCuratorScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  brains: { curator?: Brain; reviewer?: Brain } = {},
): void {
  const existing = registry.get(8);
  if (existing === undefined) {
    registry.register(8, curatorSelfLearningScenario(driver, brains));
    return;
  }
  const curatorHalf = curatorHalfScenario(brains.curator);
  registry.register(8, async (context) => {
    await existing(context);
    await curatorHalf(context);
  });
}
