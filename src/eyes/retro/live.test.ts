import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import { parseRetroVerdict, RETRO_OUTPUT_SCHEMA } from "./schema";

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
