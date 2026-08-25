import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import {
  buildDriftCandidates,
  buildDriftPrompt,
  decideDrift,
  type DriftQuestion,
} from "./drift";
import type { GitCommit } from "./git";
import {
  DRIFT_OUTPUT_SCHEMA,
  parseDriftVerdict,
  parseRetroVerdict,
  RETRO_OUTPUT_SCHEMA,
} from "./schema";

/**
 * The ONE live-luna integration test for the Retro eye (ticket #33): the real
 * `codex exec` invocation against the real prompt and schema, proving the
 * contract the fixture brain stands in for everywhere else. Skipped when the
 * codex CLI is not installed, so `bun test` never REQUIRES the subscription
 * (SPEC §13). Sandboxed to temp dirs; nothing here can reach GitHub — the eye
 * is not involved, only the brain seam.
 */
const codexAvailable = Bun.which("codex") !== null;

/** The shape ./retro.ts builds: signal blocks, then the candidate tickets. */
const PROMPT = [
  "You are the Argus Retro eye. Each block below is work in this repo that",
  "no registered ticket session covers. Decide, per block, whether real",
  "IMPLEMENTATION happened — code or configuration actually written or",
  "changed — as opposed to planning, grilling, reading or note-taking.",
  "Do not run any commands; judge only from the blocks.",
  "",
  "Emit JSON matching the output schema, one entry per signal id:",
  "- implementation: true only when something was actually implemented.",
  "- what: a short phrase naming what was done, for the title `Retro: <what>`.",
  "- summary: two or three sentences on what happened.",
  "- parentTicket: the number of the nearest plausible parent from the",
  "  candidate list below, or null when none plausibly covers this work.",
  "  Never invent a number that is not listed.",
  "",
  "[signal=retro-live-implemented sources=git,transcript dir=/repo]",
  "commits:",
  "- a1b2c3d add retry to the fetch helper (files: src/fetch-helper.ts)",
  "digest(sess-rogue, claude): Added fetchWithRetry with three attempts. DONE.",
  "johan-prompts:",
  "- just add a retry to the fetch helper, don't bother opening a ticket",
  "",
  "[signal=retro-live-planning sources=transcript dir=/repo]",
  "digest(sess-plan, codex): A planning conversation about the release order.",
  "No code was written; the session only read files and discussed sequencing.",
  "",
  "## candidate parent tickets",
  "",
  "- #15 Harden the fetch helper",
  "- #22 Write the launch announcement",
].join("\n");

describe.skipIf(!codexAvailable)("live luna brain (retro integration)", () => {
  test(
    "the real brain returns a schema-conforming retro verdict it can act on",
    async () => {
      const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-retro-"));
      try {
        const brain = createCodexBrain({
          model: DEFAULT_EYES_CONFIG.brain.model,
          reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
        });
        const outcome = await brain.evaluate({
          prompt: PROMPT,
          schema: RETRO_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const verdict = parseRetroVerdict(outcome.text);
        expect(verdict).not.toBeNull();

        const implemented = verdict!.retros.find(
          (retro) => retro.signalId === "retro-live-implemented",
        );
        expect(implemented?.implementation).toBe(true);
        expect(implemented!.what.length).toBeGreaterThan(0);
        // The eye validates the parent anyway; this asserts the model can
        // pick from the list rather than inventing a number.
        expect([null, "15", "22"]).toContain(implemented!.parentTicket);

        const planning = verdict!.retros.find(
          (retro) => retro.signalId === "retro-live-planning",
        );
        expect(planning?.implementation).toBe(false);
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
    },
    240_000,
  );
});

/**
 * The ONE live-luna test for the SCOPE-DRIFT contract (#38). It builds the
 * REAL prompt through `buildDriftPrompt` rather than a hand-copied string, so
 * what luna sees here is what the eye sends, and it is the check that would
 * catch a `required`-list mistake — #35 learned the hard way that a strict
 * schema with an omitted property fails as a bare `exit 1` with empty stderr,
 * invisible to every fixture-driven test.
 *
 * Skipped when the codex CLI is absent, so `bun test` never REQUIRES the
 * subscription (SPEC §13). Temp dirs only; the eye is not involved, so
 * nothing here can reach GitHub.
 */
function driftCommit(overrides: Partial<GitCommit>): GitCommit {
  return {
    sha: "0".repeat(40),
    authorName: "Johan Sardar",
    authorEmail: "johansardar77@gmail.com",
    ts: "2026-08-25T10:00:00Z",
    subject: "",
    body: "",
    files: [],
    diff: "",
    ...overrides,
  };
}

function question(
  ticket: string,
  title: string,
  body: string,
  commit: GitCommit,
): DriftQuestion {
  const candidate = buildDriftCandidates({
    attributed: [
      {
        dir: "/repo",
        commits: [commit],
        workingTree: null,
        coverage: { by: "session-workspace", sessionId: `sess-${ticket}`, ticket },
        sessionIds: [`sess-${ticket}`],
      },
    ],
    parentRepoOf: () => "/repo",
  })[0]!;
  return { candidate, scope: { number: ticket, title, body, state: "open" } };
}

const DRIFTED = question(
  "7",
  "Ship the widget pipeline",
  "Build the widget renderer and its cache.\n" +
    "The pipeline must stream, and the renderer needs a fixture test.",
  driftCommit({
    sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    subject: "feat: add stripe billing webhooks",
    files: ["src/billing/stripe-webhooks.ts", "src/billing/routes.ts"],
    diff:
      "--- /dev/null\n+++ b/src/billing/stripe-webhooks.ts\n" +
      "+export const onStripeEvent = (event: StripeEvent): void => {\n" +
      "+  recordSubscriptionChange(event);\n" +
      "+};\n",
  }),
);

const IN_SCOPE = question(
  "9",
  "Harden the fetch helper",
  "Retries, timeouts and error paths for src/fetch-helper.ts.\n" +
    "The retry loop needs a fixture test for the 429 path.",
  driftCommit({
    sha: "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    subject: "refactor: extract the retry loop from the fetch helper",
    files: ["src/fetch-helper.ts", "src/fetch-helper.test.ts"],
    diff:
      "--- a/src/fetch-helper.ts\n+++ b/src/fetch-helper.ts\n" +
      "+const attempt = async (url: string) => fetch(url);\n" +
      " export async function fetchWithRetry(url: string) {\n" +
      "-    const response = await fetch(url);\n" +
      "+    const response = await attempt(url);\n",
  }),
);

describe.skipIf(!codexAvailable)("live luna brain (scope-drift integration)", () => {
  test(
    "the real brain answers the scope question on contract, both directions",
    async () => {
      const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-drift-"));
      try {
        const brain = createCodexBrain({
          model: DEFAULT_EYES_CONFIG.brain.model,
          reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
        });
        const outcome = await brain.evaluate({
          prompt: buildDriftPrompt([DRIFTED, IN_SCOPE]),
          schema: DRIFT_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        // A `required` list missing a property fails HERE and nowhere else.
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const verdict = parseDriftVerdict(outcome.text);
        expect(verdict).not.toBeNull();

        const inScope = verdict!.drifts.find(
          (entry) => entry.candidateId === IN_SCOPE.candidate.id,
        );
        // The load-bearing direction: a refactor of the ticket's own code is
        // never drift, and the eye would refuse to file it either way.
        expect(inScope?.drift).toBe(false);
        expect(decideDrift(inScope!).file).toBe(false);

        const drifted = verdict!.drifts.find(
          (entry) => entry.candidateId === DRIFTED.candidate.id,
        );
        expect(drifted?.drift).toBe(true);
        // Whatever it answers, the policy gate is what decides — and a drift
        // it can act on has to be articulated.
        if (decideDrift(drifted!).file) {
          expect(drifted!.outOfScopeWork!.length).toBeGreaterThan(0);
          expect(drifted!.whyOutOfScope!.length).toBeGreaterThan(0);
        }
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
    },
    240_000,
  );
});
