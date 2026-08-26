import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveHalfTitle } from "../../harness/live-gate";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import {
  describeLiveIntegrationGate,
  LIVE_WATCHER_BRAINS_GATE,
  resolveWatcherBrainGate,
} from "../live-gate";
import { loadScaledMs } from "../test-budget";
import { buildExtractionPrompt, buildProcedurePrompt } from "./reviewer";
import {
  EXTRACTION_OUTPUT_SCHEMA,
  PROCEDURE_OUTPUT_SCHEMA,
  parseVerdict,
  type Finding,
} from "./schema";
import type { ProvenanceRecord } from "../../provenance";

/**
 * The ONE live-luna integration test (ticket #30): the real `codex exec`
 * invocation end-to-end against the researched flags. Skipped unless
 * ARGUS_LIVE_WATCHER_BRAINS=1 explicitly opts into a subscription call
 * (SPEC §1). Sandboxed to temp dirs: the brain's -C target
 * is a throwaway directory, the schema file lives in the OS temp dir, and
 * --ephemeral persists no session state. Codex reads its own real auth
 * (~/.codex) — that is the one production touchpoint a live call needs.
 *
 * AMENDED BY #91. The extraction assertion used to be
 * `expect(["user-preference", "project-fact"]).toContain(finding.kind)` —
 * satisfied by BOTH members of a two-member enum, so it could not fail on any
 * answer the schema already permitted. #71 exists because #54 measured this
 * model class turning "cmux must be >= 0.64.22" into a SKILL. The batch below
 * now carries one environment observation and one Johan preference, and the
 * test asserts the brain SEPARATES them: a brain that answers
 * "user-preference" to everything fails on the observation, and one that
 * answers "project-fact" to everything fails on the preference.
 */
const liveGate = resolveWatcherBrainGate({
  codexInstalled: Bun.which("codex") !== null,
  env: Bun.env,
});
console.log(
  describeLiveIntegrationGate(
    "live Reviewer watcher-brain integration",
    LIVE_WATCHER_BRAINS_GATE,
    liveGate,
  ),
);

/** A minimal provenance record, so the live call uses the PRODUCTION prompt. */
function liveRecord(
  uuid: string,
  author: ProvenanceRecord["author"],
  role: "assistant" | "user",
  text: string,
): ProvenanceRecord {
  return {
    sessionId: "live-sess",
    author,
    via: author === "johan" ? "takeover" : "assistant",
    registered: true,
    startedBy: "hermes",
    johanTouched: author === "johan",
    ts: "2026-08-25T00:00:00.000Z",
    text,
    event: {
      type: "message",
      sessionId: "live-sess",
      role,
      text,
      ts: "2026-08-25T00:00:00.000Z",
      uuid,
      candidate: role === "user",
      file: "/transcripts/live-sess.jsonl",
    },
  };
}

/** One real `codex exec` round trip each; stretched under load (see retro). */
const BUDGET_MS = loadScaledMs(240_000, 600_000);

/**
 * The #71 case verbatim: an observation of how the environment IS. It is a
 * project-fact, and it is never a procedure — there is no method in it.
 */
const ENVIRONMENT = liveRecord(
  "live-env",
  "agent",
  "assistant",
  "Checked on this machine: cmux must be at least 0.64.22, below that the " +
    "dispatcher loop dies with its terminal.",
);

/** Johan, in his own voice, about how he wants work done. */
const PREFERENCE = liveRecord(
  "live-pref",
  "johan",
  "user",
  "please always write commit messages in present tense, I keep saying this",
);

/** Where a finding's content lives, for the substring anchors below. */
function textOf(finding: Finding): string {
  return `${finding.slug} ${finding.title} ${finding.content}`.toLowerCase();
}

describe.skipIf(liveGate.status !== "run")(
  liveHalfTitle("live luna brain (integration)", liveGate),
  () => {
    test(
      "the real brain files the environment observation as a fact and Johan's ask as a preference",
      async () => {
      const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-luna-"));
      try {
        const brain = createCodexBrain({
          model: DEFAULT_EYES_CONFIG.brain.model,
          reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
        });
        const outcome = await brain.evaluate({
          prompt: buildExtractionPrompt([PREFERENCE, ENVIRONMENT]),
          schema: EXTRACTION_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        console.log(`argus: live reviewer extraction verdict\n${outcome.text}`);
        const verdict = parseVerdict(outcome.text, [
          "user-preference",
          "project-fact",
        ]);
        expect(verdict).not.toBeNull();

        // The slug is the model's to choose, so each finding is identified by
        // a string it was HANDED — "0.64.22" and "present tense" are verbatim
        // from the blocks. The graded proposition is the `kind`, and that is
        // asserted exactly.
        const environment = verdict!.findings.filter((finding) =>
          textOf(finding).includes("0.64.22"),
        );
        expect(environment.length).toBeGreaterThan(0);
        for (const finding of environment) {
          expect(finding.kind).toBe("project-fact");
        }

        const preference = verdict!.findings.filter((finding) =>
          textOf(finding).includes("present tense"),
        );
        expect(preference.length).toBeGreaterThan(0);
        for (const finding of preference) {
          expect(finding.kind).toBe("user-preference");
          // The provenance gate checks this against the registry anyway; here
          // it proves the model read the block it derived from.
          expect(finding.sources).toContain("live-pref");
        }
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
      },
      BUDGET_MS,
    );

    /**
     * The NEGATIVE control, and the whole of #71 in one assertion: handed the
     * environment observation ALONE, the skills writer must say nothing. A
     * brain that is merely agreeable writes `Upgrade cmux before acceptance
     * testing` here — which is what #54 measured it doing on every attempt —
     * and this test goes red.
     */
    test(
      "the skills writer returns nothing for an environment observation",
      async () => {
      const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-luna-skill-"));
      try {
        const brain = createCodexBrain({
          model: DEFAULT_EYES_CONFIG.brain.model,
          reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
        });
        const outcome = await brain.evaluate({
          prompt: buildProcedurePrompt([ENVIRONMENT]),
          schema: PROCEDURE_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        console.log(`argus: live skills-writer verdict\n${outcome.text}`);
        const verdict = parseVerdict(outcome.text, ["procedure"]);
        expect(verdict).not.toBeNull();
        expect(verdict!.findings).toEqual([]);
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
      },
      BUDGET_MS,
    );
  },
);
