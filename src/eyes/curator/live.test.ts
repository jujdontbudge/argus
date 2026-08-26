import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveHalfTitle } from "../../harness/live-gate";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import { loadScaledMs } from "../test-budget";
import {
  describeLiveIntegrationGate,
  LIVE_WATCHER_BRAINS_GATE,
  resolveWatcherBrainGate,
} from "../live-gate";
import { buildCuratorPrompt } from "./prompt";
import { CURATOR_OUTPUT_SCHEMA, parseCuratorVerdict } from "./schema";

/**
 * The ONE live-luna integration test for the curator pass (ticket #35): the
 * real `codex exec` against the real prompt and schema, proving the contract
 * the stub brain stands in for everywhere else. Skipped unless
 * ARGUS_LIVE_WATCHER_BRAINS=1 explicitly opts into a subscription call
 * (SPEC §1).
 * Sandboxed to a temp dir; the eye is not involved, only the brain seam, so
 * nothing here can move a file in any repo.
 *
 * AMENDED BY #91. The memory half of this test used to assert NOTHING: it
 * planted facts and an orphan, spent the call, and then only checked two
 * SKILL decisions. Worse, the planted facts were two spellings of one
 * proposition, so merging them and merging everything were indistinguishable.
 * The set now carries distinct controls, and the assertions below grade the
 * judgment rather than the parse.
 */
const liveGate = resolveWatcherBrainGate({
  codexInstalled: Bun.which("codex") !== null,
  env: Bun.env,
});
console.log(
  describeLiveIntegrationGate(
    "live Curator watcher-brain integration",
    LIVE_WATCHER_BRAINS_GATE,
    liveGate,
  ),
);

/** One real `codex exec` round trip; stretched under load, per retro's note. */
const BUDGET_MS = loadScaledMs(240_000, 600_000);

const PROMPT = buildCuratorPrompt({
  dryRun: false,
  skills: [
    {
      name: "release-runbook",
      description: "cut a release end to end",
      relative: "release-runbook",
      state: "active",
      idleDays: 1,
      useCount: 40,
      viewCount: 22,
      patchCount: 4,
      supportFiles: ["references/versioning.md", "templates/notes.md"],
    },
    {
      name: "release-runbook-staging",
      description: "cut a staging release",
      relative: "release-runbook-staging",
      state: "stale",
      idleDays: 44,
      useCount: 1,
      viewCount: 1,
      patchCount: 0,
      supportFiles: [],
    },
  ],
  facts: [
    // The pair that MUST merge: two spellings of one proposition.
    { slug: "metro-port", title: "Metro runs on 8082", idleDays: 5, indexed: true },
    { slug: "metro-8082", title: "Metro listens on port 8082", idleDays: 6, indexed: true },
    // The controls that MUST survive: distinct propositions about different
    // subsystems, sharing no subject with each other or with the pair. #54
    // measured this model class consolidating real content away; without a
    // control, "merge everything" and "merge the duplicate" look identical.
    {
      slug: "archive-fts5",
      title: "The archive is a SQLite FTS5 index",
      idleDays: 12,
      indexed: true,
    },
    {
      slug: "launchd-login",
      title: "launchd starts the eyes on login",
      idleDays: 9,
      indexed: true,
    },
  ],
  orphans: [{ kind: "index-without-file", slug: "ghost" }],
});

/** The duplicate pair, in whichever direction the brain chose to merge it. */
const DUPLICATE_PAIR = ["metro-8082", "metro-port"].join("|");

/** Facts that are about different things and must not be touched. */
const DISTINCT_FACTS = ["archive-fts5", "launchd-login"];

describe.skipIf(liveGate.status !== "run")(
  liveHalfTitle("live luna brain (curator integration)", liveGate),
  () => {
  test(
    "the real brain merges the duplicate fact and leaves the distinct ones whole",
    async () => {
      const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-curator-"));
      try {
        const brain = createCodexBrain({
          model: DEFAULT_EYES_CONFIG.brain.model,
          reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
        });
        const outcome = await brain.evaluate({
          prompt: PROMPT,
          schema: CURATOR_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // The raw verdict is the evidence artifact (#91): what the brain
        // actually said, printed beside the assertions it then had to satisfy.
        console.log(`argus: live curator verdict\n${outcome.text}`);
        const verdict = parseCuratorVerdict(outcome.text);
        expect(verdict).not.toBeNull();
        expect(verdict!.summary.length).toBeGreaterThan(0);

        // The judgment that matters: the busy, recently-used umbrella is not
        // the thing to retire. Everything else the eye validates itself.
        expect(verdict!.prunings.map(({ name }) => name)).not.toContain(
          "release-runbook",
        );
        expect(
          verdict!.consolidations.map(({ from }) => from),
        ).not.toContain("release-runbook");

        // #91 — THE MEMORY HALF, which asserted nothing until now. SPEC.md:276
        // promises this pass compacts the memory files, and the planted set is
        // built so that both wrong answers are visible: a brain that merges
        // nothing fails the first assertion, and one that merges everything —
        // the #54 failure — fails the second.
        const merges = verdict!.memory.merges;
        const mergedSlugs = merges.flatMap(({ from, into }) => [from, into]);
        const prunedSlugs = verdict!.memory.prunings.map(({ slug }) => slug);

        // 1. The genuine duplicate is merged. WHICH of the two keeps the
        //    content is a real choice between two right answers, so the
        //    assertion is on the unordered pair; that both slugs appear
        //    together in one merge is not.
        expect(
          merges.map(({ from, into }) => [from, into].sort().join("|")),
        ).toContain(DUPLICATE_PAIR);

        // 2. The distinct facts survive whole. Over-merging is the dangerous
        //    answer: it destroys content, and it is what #54 measured.
        for (const slug of DISTINCT_FACTS) {
          expect(mergedSlugs).not.toContain(slug);
          expect(prunedSlugs).not.toContain(slug);
        }

        // 3. The orphan is the eye's to repair (phase 6, `repairMemoryIndex`)
        //    and the schema has no field for it, so what the brain owes here
        //    is restraint: `ghost` is an index line with no fact file behind
        //    it, and merging or pruning it as though it were a fact would be
        //    the brain acting outside its half of the contract.
        expect(mergedSlugs).not.toContain("ghost");
        expect(prunedSlugs).not.toContain("ghost");
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
    },
    BUDGET_MS,
  );
  },
);
