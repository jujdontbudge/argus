import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import { buildExtractionPrompt } from "./reviewer";
import { EXTRACTION_OUTPUT_SCHEMA, parseVerdict } from "./schema";
import type { ProvenanceRecord } from "../../provenance";

/**
 * The ONE live-luna integration test (ticket #30): the real `codex exec`
 * invocation end-to-end against the researched flags. Skipped when the codex
 * CLI is not installed, so `bun test` never REQUIRES the subscription
 * (SPEC §13 testing policy). Sandboxed to temp dirs: the brain's -C target
 * is a throwaway directory, the schema file lives in the OS temp dir, and
 * --ephemeral persists no session state. Codex reads its own real auth
 * (~/.codex) — that is the one production touchpoint a live call needs.
 */
const codexAvailable = Bun.which("codex") !== null;

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

describe.skipIf(!codexAvailable)("live luna brain (integration)", () => {
  test(
    "the lean luna invocation returns a schema-conforming reviewer verdict",
    async () => {
      const sandboxRepo = await mkdtemp(join(tmpdir(), "argus-live-luna-"));
      try {
        const brain = createCodexBrain({
          model: DEFAULT_EYES_CONFIG.brain.model,
          reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
        });
        const outcome = await brain.evaluate({
          prompt: buildExtractionPrompt([
            liveRecord(
              "live-1",
              "johan",
              "user",
              "please always write commit messages in present tense, I keep saying this",
            ),
            liveRecord(
              "live-2",
              "agent",
              "assistant",
              "Done. Also noted the dev server only binds on port 4114 in this repo.",
            ),
          ]),
          schema: EXTRACTION_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const verdict = parseVerdict(outcome.text);
          expect(verdict).not.toBeNull();
          // #69: the extraction pass can return facts and nothing else.
          for (const finding of verdict!.findings) {
            expect(["user-preference", "project-fact"]).toContain(finding.kind);
          }
        }
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
    },
    240_000,
  );
});
