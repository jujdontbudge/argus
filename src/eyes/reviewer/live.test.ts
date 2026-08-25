import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import { parseVerdict, REVIEWER_OUTPUT_SCHEMA } from "./schema";

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
          prompt: [
            "You are the Argus Reviewer eye. The blocks below are transcript",
            "turns tagged with registry-verified authors. Decide whether",
            "anything DURABLE happened. Do not run any commands; judge only",
            "from the blocks. Emit findings as JSON matching the output",
            "schema; cite each finding's source uuids. Use kind",
            '"user-preference" only for blocks with author=johan.',
            "",
            "[uuid=live-1 author=johan session=s1 role=user ts=2026-08-25T00:00:00Z]",
            "please always write commit messages in present tense, I keep saying this",
            "",
            "[uuid=live-2 author=agent session=s1 role=assistant ts=2026-08-25T00:00:05Z]",
            "Done. Also noted the dev server only binds on port 4114 in this repo.",
          ].join("\n"),
          schema: REVIEWER_OUTPUT_SCHEMA,
          cwd: sandboxRepo,
        });

        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const verdict = parseVerdict(outcome.text);
          expect(verdict).not.toBeNull();
          for (const finding of verdict!.findings) {
            expect(["user-preference", "project-fact", "procedure"]).toContain(
              finding.kind,
            );
          }
        }
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
    },
    240_000,
  );
});
