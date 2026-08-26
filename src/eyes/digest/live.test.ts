import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveHalfTitle } from "../../harness/live-gate";
import type { ProvenanceRecord } from "../../provenance";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import {
  describeLiveIntegrationGate,
  LIVE_WATCHER_BRAINS_GATE,
  resolveWatcherBrainGate,
} from "../live-gate";
import { loadScaledMs } from "../test-budget";
import { buildDigestPrompt, type PendingEntry } from "./digest";
import { DIGEST_OUTPUT_SCHEMA, parseDigestVerdict } from "./schema";

/**
 * The ONE live-luna integration test for the Digest eye (ticket #91). Until
 * now the digest was the only judgment eye without one — reviewer, curator and
 * retro each had theirs — and its `status:` field is not narrative decoration:
 * it doubles as the §6 slow-poll signal (SPEC.md:307-308), so a brain that
 * judges the status wrongly degrades signal delivery for every reader of
 * INDEX.md, not just the prose.
 *
 * The test is a DISCRIMINATION, in the shape retro/live.test.ts already uses.
 * One batch, two sessions: one that plainly concluded and one that plainly did
 * not. A brain that answers "done" to everything fails on the second; one that
 * answers "running" to everything fails on the first; "blocked" fails both.
 * Neither session asks a human anything, so `blocked` is wrong for both.
 *
 * Skipped unless ARGUS_LIVE_WATCHER_BRAINS=1 explicitly opts into a
 * subscription call (SPEC §1). Sandboxed to a temp dir; the eye is not
 * involved, only the brain seam, so nothing here can write a digest file.
 */
const liveGate = resolveWatcherBrainGate({
  codexInstalled: Bun.which("codex") !== null,
  env: Bun.env,
});
console.log(
  describeLiveIntegrationGate(
    "live Digest watcher-brain integration",
    LIVE_WATCHER_BRAINS_GATE,
    liveGate,
  ),
);

/** One real `codex exec` round trip; stretched under load (see retro). */
const BUDGET_MS = loadScaledMs(240_000, 600_000);

const FINISHED_SESSION = "sess-finished";
const MIDRUN_SESSION = "sess-midrun";

function entry(
  root: string,
  author: ProvenanceRecord["author"],
  role: "assistant" | "user",
  text: string,
): PendingEntry {
  return {
    ingestedAt: 0,
    root,
    record: {
      sessionId: root,
      author,
      via: author === "johan" ? "takeover" : "assistant",
      registered: true,
      startedBy: "hermes",
      johanTouched: author === "johan",
      ts: "2026-08-25T00:00:00.000Z",
      text,
      event: {
        type: "message",
        sessionId: root,
        role,
        text,
        ts: "2026-08-25T00:00:00.000Z",
        uuid: `${root}-${role}`,
        candidate: role === "user",
        file: `/transcripts/${root}.jsonl`,
      },
    },
  };
}

/**
 * The two propositions. Each is unambiguous by construction: the first says
 * the work is finished and there is nothing left, the second says work is
 * still in flight and names the next step it is about to take. Neither
 * addresses a question to a human, so neither is `blocked`.
 */
const BATCH: PendingEntry[] = [
  entry(
    FINISHED_SESSION,
    "agent",
    "assistant",
    "The retry loop is implemented and all 14 tests pass. I opened the pull " +
      "request, it was merged, and I deleted the branch. There is nothing " +
      "left to do on this ticket — I am finished.",
  ),
  entry(
    MIDRUN_SESSION,
    "agent",
    "assistant",
    "I have converted 2 of the 7 call sites so far. Continuing now with " +
      "src/queue/worker.ts and the four after it; nothing is blocking me and " +
      "the work is still in progress.",
  ),
];

describe.skipIf(liveGate.status !== "run")(
  liveHalfTitle("live luna brain (digest integration)", liveGate),
  () => {
    test(
      "the real brain separates a concluded session from one still running",
      async () => {
        const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-digest-"));
        try {
          const brain = createCodexBrain({
            model: DEFAULT_EYES_CONFIG.brain.model,
            reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
          });
          const outcome = await brain.evaluate({
            prompt: buildDigestPrompt(BATCH),
            schema: DIGEST_OUTPUT_SCHEMA,
            cwd: sandboxRepo,
          });

          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          console.log(`argus: live digest verdict\n${outcome.text}`);
          const verdict = parseDigestVerdict(outcome.text);
          expect(verdict).not.toBeNull();

          const finished = verdict!.sessions.find(
            (session) => session.sessionId === FINISHED_SESSION,
          );
          const midrun = verdict!.sessions.find(
            (session) => session.sessionId === MIDRUN_SESSION,
          );
          // The prompt requires one entry per distinct session id; a missing
          // half is a contract miss, not a judgment call.
          expect(finished).toBeDefined();
          expect(midrun).toBeDefined();

          // The §6 signal. Asserted exactly — `status` is a three-member enum
          // and there is nothing to be tolerant of.
          expect(finished!.status).toBe("done");
          expect(midrun!.status).toBe("running");

          // A status with no narrative behind it is not a digest entry.
          for (const session of [finished!, midrun!]) {
            expect(session.narrative.trim().length).toBeGreaterThan(0);
            expect(session.summary.trim().length).toBeGreaterThan(0);
          }
        } finally {
          await rm(sandboxRepo, { force: true, recursive: true });
        }
      },
      BUDGET_MS,
    );
  },
);
