/**
 * SPEC §13 scenarios for the Digest eye: slot 1 extended (autonomous batch —
 * digests + INDEX updated), slot 2 extended (fake-Johan takeover —
 * `johan_touched: true` in the digest), and slot 7 (signal paths — status
 * flips surface through the digest's `status:` field within the cadence even
 * with the push hooks disabled).
 *
 * Message flow reuses the provenance fixture driver (#25's seam); the brain
 * is a deterministic fixture that reads the eye's own prompt blocks, so the
 * full pipeline (classify → coalesce → evaluate → write) runs for real with
 * no LLM, on a virtual clock.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox, ScenarioHandler, ScenarioRegistry } from "../../harness/index.ts";
import {
  classifierFromRegistry,
  createFixtureProvenanceDriver,
  loadRegistry,
  registryPaths,
  type ProvenanceScenarioDriver,
} from "../../provenance";
import type { Brain } from "../brain";
import { createBrainCap } from "../cap";
import { autonomousBatchScenario, reviewerTakeoverScenario } from "../reviewer/scenarios";
import { DigestEye } from "./digest";
import type { BrainStatus } from "./schema";

export interface DigestScenarioBrains {
  digest?: Brain;
  reviewer?: Brain;
}

/** ADR-0002 digest cadence: 30s quiet / 120s max. */
const CADENCE = { quietWindowSeconds: 30, maxWaitSeconds: 120 };

/** One prompt block as the eye renders it: `[session=… author=… …]\ntext`. */
interface PromptBlock {
  sessionId: string;
  author: string;
  text: string;
}

function promptBlocks(prompt: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  const pattern = /\[session=([^ \]]+) author=([^ \]]+)[^\]]*\]\n([^\n]*)/g;
  for (const match of prompt.matchAll(pattern)) {
    blocks.push({ sessionId: match[1]!, author: match[2]!, text: match[3]! });
  }
  return blocks;
}

/**
 * The deterministic digest brain: per session in the prompt, narrative from
 * the block texts and status judged from completion/blockage markers.
 */
function fixtureDigestBrain(): Brain {
  return {
    async evaluate({ prompt }) {
      const bySession = new Map<string, string[]>();
      for (const block of promptBlocks(prompt)) {
        bySession.set(block.sessionId, [
          ...(bySession.get(block.sessionId) ?? []),
          block.text,
        ]);
      }
      return {
        ok: true,
        text: JSON.stringify({
          sessions: [...bySession.entries()].map(([sessionId, texts]) => {
            const status: BrainStatus = texts.some((text) => text.includes("DONE"))
              ? "done"
              : texts.some((text) => text.includes("BLOCKED"))
                ? "blocked"
                : "running";
            return {
              sessionId,
              narrative: texts.join(" / "),
              summary:
                status === "done"
                  ? "finished"
                  : status === "blocked"
                    ? "waiting on a human"
                    : "progressing",
              status,
            };
          }),
        }),
      };
    },
  };
}

/**
 * Classify everything the sandbox's transcripts produced and run one full
 * coalesced digest evaluation over it, firing EXACTLY when the batch comes
 * due on the virtual clock. Returns how long after ingest that was — the
 * §6 surfacing latency the signal-paths scenario bounds.
 */
async function runDigestOnce(
  sandbox: Sandbox,
  driver: ProvenanceScenarioDriver,
  brain: Brain = fixtureDigestBrain(),
): Promise<{ dueAfterMs: number | null }> {
  const registry = await loadRegistry(registryPaths(sandbox.repo));
  const { classifier } = classifierFromRegistry(registry);
  const records = [];
  for (const event of await driver.events(sandbox)) {
    const { record } = classifier.handle(event);
    if (record) records.push(record);
  }

  let nowMs = 0;
  const eye = await DigestEye.open({
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
  const dueAfterMs = eye.dueAt();
  if (dueAfterMs !== null) {
    nowMs = dueAfterMs;
    await eye.tick();
  }
  return { dueAfterMs };
}

const sessionsPath = (sandbox: Sandbox, name: string): string =>
  join(sandbox.repo, ".argus/sessions", name);

/** §13 scenario 1 — autonomous batch: reviewer half + the digest half (slot 1). */
export function digestAutonomousBatchScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  brains: DigestScenarioBrains = {},
): ScenarioHandler {
  const reviewerHalf = autonomousBatchScenario(driver, brains.reviewer);
  return async (context) => {
    await reviewerHalf(context);
    const { assert, sandbox } = context;

    // The digest half: the deployed batch session (sess-batch, ticket 7)
    // must end up with a running digest and its one INDEX.md line.
    await runDigestOnce(sandbox, driver, brains.digest);

    const digest = await Bun.file(sessionsPath(sandbox, "7-sess-batch.md")).text();
    assert(
      digest.includes("status: running") &&
        digest.includes("johan_touched: false") &&
        (brains.digest === undefined
          ? digest.includes("status check — keep going")
          : /status check/i.test(digest) && /(continue|progress)/i.test(digest)),
      "the session's digest was written with narrative",
    );
    const index = await Bun.file(sessionsPath(sandbox, "INDEX.md")).text();
    assert(
      index
        .split("\n")
        .filter((line) => line.startsWith("- 7-sess-batch.md — "))
        .length === 1 && index.includes("status=running"),
      "INDEX.md gained the session's one line",
    );
  };
}

/** §13 scenario 2 — takeover: earlier halves + the digest half (slot 2). */
export function digestTakeoverScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  brains: DigestScenarioBrains = {},
): ScenarioHandler {
  const earlierHalves = reviewerTakeoverScenario(driver, brains.reviewer);
  return async (context) => {
    await earlierHalves(context);
    const { assert, sandbox } = context;

    await runDigestOnce(sandbox, driver, brains.digest);

    const digest = await Bun.file(
      sessionsPath(sandbox, "42-sess-takeover.md"),
    ).text();
    assert(
      digest.includes("johan_touched: true"),
      "the digest frontmatter carries johan_touched: true",
    );
    assert(
      brains.digest === undefined
        ? digest.includes("stop — ship the auth fix first, then come back")
        : /auth fix/i.test(digest) && /(before|first|priorit)/i.test(digest),
      "the takeover directive is in the digest narrative",
    );
    const index = await Bun.file(sessionsPath(sandbox, "INDEX.md")).text();
    assert(
      index.includes("- 42-sess-takeover.md — ") &&
        index.includes("johan_touched=true"),
      "INDEX.md surfaces johan_touched=true",
    );
  };
}

/** §13 scenario 7 — signal paths: the slow-poll fallback (slot 7). */
export function signalPathsScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  brain?: Brain,
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const finisher = await driver.deploy({
      sandbox,
      sessionId: "sess-finisher",
      agent: "claude",
      ticket: "8",
      dispatchPrompt: "Implement ticket #8, then print DONE and stop.",
    });
    await finisher.agentSays("Implemented ticket #8, gates green. DONE.");

    const blocker = await driver.deploy({
      sandbox,
      sessionId: "sess-blocker",
      agent: "codex",
      ticket: "9",
      dispatchPrompt: "Implement ticket #9.",
    });
    await blocker.agentSays(
      "BLOCKED: I need the production API key from Johan to continue.",
    );

    // Hooks disabled: no push events exist anywhere — the ONLY signal path
    // left is the digest's status field, swept from INDEX.md by the poll.
    let eventFiles: string[] = [];
    try {
      eventFiles = await readdir(join(sandbox.repo, ".argus/events"));
    } catch {
      // Missing directory: no events were ever pushed.
    }
    assert(eventFiles.length === 0, "no push event files exist — hooks are disabled");

    const { dueAfterMs } = await runDigestOnce(sandbox, driver, brain);
    assert(
      dueAfterMs !== null && dueAfterMs <= CADENCE.maxWaitSeconds * 1_000,
      "the pending batch was due within the digest cadence (the poll interval bound)",
    );

    const index = await Bun.file(sessionsPath(sandbox, "INDEX.md")).text();
    const lineFor = (file: string): string =>
      index.split("\n").find((line) => line.startsWith(`- ${file} — `)) ?? "";
    assert(
      lineFor("8-sess-finisher.md").includes("status=done"),
      "the finished session surfaced status=done in INDEX.md",
    );
    assert(
      lineFor("9-sess-blocker.md").includes("status=blocked"),
      "the blocked session surfaced status=blocked in INDEX.md",
    );
    assert(
      (await Bun.file(sessionsPath(sandbox, "8-sess-finisher.md")).text()).includes(
        "status: done",
      ) &&
        (await Bun.file(sessionsPath(sandbox, "9-sess-blocker.md")).text()).includes(
          "status: blocked",
        ),
      "both digests carry the flipped status in frontmatter",
    );
  };
}

/** Register the digest's §13 slots: 7, and the extended slots 1 and 2. */
export function registerDigestScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  brains: DigestScenarioBrains = {},
): void {
  registry.register(1, digestAutonomousBatchScenario(driver, brains));
  registry.register(2, digestTakeoverScenario(driver, brains));
  registry.register(7, signalPathsScenario(driver, brains.digest));
}
