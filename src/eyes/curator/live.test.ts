import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexBrain } from "../brain";
import { DEFAULT_EYES_CONFIG } from "../config";
import { buildCuratorPrompt } from "./prompt";
import { CURATOR_OUTPUT_SCHEMA, parseCuratorVerdict } from "./schema";

/**
 * The ONE live-luna integration test for the curator pass (ticket #35): the
 * real `codex exec` against the real prompt and schema, proving the contract
 * the stub brain stands in for everywhere else. Skipped when the codex CLI is
 * not installed, so `bun test` never REQUIRES the subscription (SPEC §13).
 * Sandboxed to a temp dir; the eye is not involved, only the brain seam, so
 * nothing here can move a file in any repo.
 */
const codexAvailable = Bun.which("codex") !== null;

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
    { slug: "metro-port", title: "Metro runs on 8082", idleDays: 5, indexed: true },
    { slug: "metro-8082", title: "Metro listens on port 8082", idleDays: 6, indexed: true },
  ],
  orphans: [{ kind: "index-without-file", slug: "ghost" }],
});

describe.skipIf(!codexAvailable)("live luna brain (curator integration)", () => {
  test(
    "the real brain returns a schema-conforming curator verdict the eye can act on",
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
      } finally {
        await rm(sandboxRepo, { force: true, recursive: true });
      }
    },
    240_000,
  );
});
