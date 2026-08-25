/**
 * SPEC §13 scenarios 1 (autonomous batch — the reviewer's assertions), 2
 * (fake-Johan takeover — extended with the reviewer half: USER.md learns) and
 * 8 (self-learning loop — novel procedure becomes a skill) as executable
 * harness scenarios.
 *
 * Message flow reuses the provenance fixture driver (#25's seam): registry
 * rows land in the sandbox repo's real `.argus/registry/` and messages become
 * the tail events a real transcript would yield. The brain is a deterministic
 * fixture — it reads the eye's own prompt blocks, so the full pipeline
 * (classify → coalesce → evaluate → gate → write) runs for real with no LLM.
 */
import { join } from "node:path";
import type { Sandbox, ScenarioHandler, ScenarioRegistry } from "../../harness/index.ts";
import {
  classifierFromRegistry,
  createFixtureProvenanceDriver,
  loadRegistry,
  registryPaths,
  takeoverScenario,
  type ProvenanceScenarioDriver,
} from "../../provenance";
import type { Brain } from "../brain";
import { createBrainCap } from "../cap";
import { ReviewerEye } from "./reviewer";

const CADENCE = { quietWindowSeconds: 30, maxWaitSeconds: 300 };

/** One prompt block as the eye renders it: `[uuid=… author=… …]\ntext`. */
interface PromptBlock {
  uuid: string;
  author: string;
  text: string;
}

function promptBlocks(prompt: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  const pattern = /\[uuid=([^ \]]+) author=([^ \]]+)[^\]]*\]\n([^\n]*)/g;
  for (const match of prompt.matchAll(pattern)) {
    blocks.push({ uuid: match[1]!, author: match[2]!, text: match[3]! });
  }
  return blocks;
}

/**
 * Classify everything the sandbox's transcripts produced and run one full
 * coalesced evaluation over it with the given brain, on a virtual clock.
 */
async function runReviewerOnce(
  sandbox: Sandbox,
  driver: ProvenanceScenarioDriver,
  brain: Brain,
): Promise<void> {
  const registry = await loadRegistry(registryPaths(sandbox.repo));
  const { classifier } = classifierFromRegistry(registry);
  const records = [];
  for (const event of await driver.events(sandbox)) {
    const { record } = classifier.handle(event);
    if (record) records.push(record);
  }

  let nowMs = 0;
  const eye = await ReviewerEye.open({
    repo: sandbox.repo,
    brain,
    cap: createBrainCap({
      directory: join(sandbox.root, "state/brain-slots"),
      maxConcurrency: 2,
      pollMs: 1,
    }),
    cadence: CADENCE,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    onAlert: () => {},
  });
  await eye.ingest(records);
  nowMs = CADENCE.maxWaitSeconds * 1_000 + 1_000;
  await eye.tick();
}

const memoryPath = (sandbox: Sandbox, name: string): string =>
  join(sandbox.repo, ".argus/memory", name);

/** §13 scenario 1 — autonomous batch, zero human input (slot 1). */
export function autonomousBatchScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const seededUser = "# USER.md\n\n- Johan exists <!-- argus:johan-exists -->\n";
    await Bun.write(memoryPath(sandbox, "USER.md"), seededUser);

    const session = await driver.deploy({
      sandbox,
      sessionId: "sess-batch",
      agent: "codex",
      ticket: "7",
      dispatchPrompt: "Implement ticket #7. Note: metro runs on 8082 here.",
    });
    await session.hermesSend("status check — keep going");

    // An adversarial brain: it claims a Johan preference while citing a
    // Hermes-authored message. The registry gate, not the model, must decide.
    const brain: Brain = {
      async evaluate({ prompt }) {
        const blocks = promptBlocks(prompt);
        return {
          ok: true,
          text: JSON.stringify({
            findings: [
              {
                kind: "user-preference",
                slug: "sneaky-preference",
                title: "Sneaky",
                content: "Johan supposedly loves status checks.",
                sources: [blocks[0]!.uuid],
              },
              {
                kind: "project-fact",
                slug: "metro-port",
                title: "Metro port",
                content: "Metro runs on 8082.",
                sources: blocks.map(({ uuid }) => uuid),
              },
            ],
          }),
        };
      },
    };
    await runReviewerOnce(sandbox, driver, brain);

    assert(
      (await Bun.file(memoryPath(sandbox, "USER.md")).text()) === seededUser,
      "USER.md stayed byte-identical",
    );
    const index = await Bun.file(memoryPath(sandbox, "MEMORY.md")).text();
    assert(index.includes("metro-port.md"), "MEMORY.md gained a project fact");
    assert(
      (await Bun.file(memoryPath(sandbox, "metro-port.md")).text()).includes(
        "Metro runs on 8082.",
      ),
      "the fact file exists beside the index",
    );
  };
}

/** §13 scenario 2 — fake-Johan takeover, provenance + reviewer halves (slot 2). */
export function reviewerTakeoverScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  const provenanceHalf = takeoverScenario(driver);
  return async (context) => {
    await provenanceHalf(context);

    // The reviewer half: the takeover directive (already in the sandbox's
    // events) must flow into USER.md — it is the one Johan-authored message.
    const brain: Brain = {
      async evaluate({ prompt }) {
        const johan = promptBlocks(prompt).filter(
          ({ author }) => author === "johan",
        );
        return {
          ok: true,
          text: JSON.stringify({
            findings: johan.map(({ uuid, text }, index) => ({
              kind: "user-preference",
              slug: `takeover-directive-${index + 1}`,
              title: "Takeover directive",
              content: text,
              sources: [uuid],
            })),
          }),
        };
      },
    };
    await runReviewerOnce(context.sandbox, driver, brain);

    const user = await Bun.file(memoryPath(context.sandbox, "USER.md")).text();
    context.assert(
      user.includes("stop — ship the auth fix first, then come back"),
      "USER.md learned from the takeover directive",
    );
  };
}

/** §13 scenario 8 — self-learning loop (slot 8). */
export function selfLearningScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const procedure =
      "PROCEDURE: rotate the staging cert — 1) pull vault secret 2) run refresh-cert.sh 3) restart caddy";
    for (const sessionId of ["sess-novel-1", "sess-novel-2"]) {
      const session = await driver.deploy({
        sandbox,
        sessionId,
        agent: "claude",
        dispatchPrompt: `work the queue (${sessionId})`,
      });
      await session.johanTypes(procedure);
    }

    // Fires only once the SAME novel procedure has been seen more than once
    // across sessions — the "repeat" in SPEC §13.8.
    const brain: Brain = {
      async evaluate({ prompt }) {
        const repeats = promptBlocks(prompt).filter(({ text }) =>
          text.startsWith("PROCEDURE: rotate the staging cert"),
        );
        return {
          ok: true,
          text: JSON.stringify({
            findings:
              repeats.length >= 2
                ? [
                    {
                      kind: "procedure",
                      slug: "rotate-staging-cert",
                      title: "Rotate the staging cert",
                      content: repeats[0]!.text,
                      sources: repeats.map(({ uuid }) => uuid),
                    },
                  ]
                : [],
          }),
        };
      },
    };
    await runReviewerOnce(sandbox, driver, brain);

    const skill = Bun.file(
      join(sandbox.repo, ".argus/skills/rotate-staging-cert/SKILL.md"),
    );
    assert(
      (await skill.exists()) &&
        (await skill.text()).includes("run refresh-cert.sh"),
      "the novel procedure was written as a SKILL.md under .argus/skills",
    );
  };
}

/** Register the reviewer's §13 slots: 1 and 8, and the extended slot 2. */
export function registerReviewerScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): void {
  registry.register(1, autonomousBatchScenario(driver));
  registry.register(2, reviewerTakeoverScenario(driver));
  registry.register(8, selfLearningScenario(driver));
}
