import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  classifierFromRegistry,
  loadRegistry,
  ProvenanceClassifier,
  registryPaths,
} from "./index";
import type { MessageEvent } from "../tailing";

const T0 = "2026-08-24T12:00:00.000Z";
const t0 = Date.parse(T0);
const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

function userMessage(sessionId: string, text: string, ts: string): MessageEvent {
  return {
    type: "message",
    sessionId,
    role: "user",
    text,
    ts,
    candidate: true,
    file: `/transcripts/${sessionId}.jsonl`,
  };
}

describe("registry files → classifier (the wired seam)", () => {
  test("classifierFromRegistry replays sessions + sends and carries the audits", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-provenance-"));
    try {
      const paths = registryPaths(root);
      await mkdir(dirname(paths.sessionsFile), { recursive: true });
      await writeFile(
        paths.sessionsFile,
        [
          JSON.stringify({
            ts: T0,
            sessionId: "sess-a",
            agent: "claude",
            ticket: "25",
            dispatchPrompt: "Build the provenance classifier.",
          }),
          "corrupt line",
          "",
        ].join("\n"),
      );
      await writeFile(
        paths.sendsFile,
        `${JSON.stringify({
          ts: iso(60_000),
          sessionId: "sess-a",
          text: "how is it going?",
        })}\n${JSON.stringify({
          ts: iso(60_000),
          sessionId: "sess-ghost",
          text: "ghost nudge",
        })}\n`,
      );

      const { classifier, audits } = classifierFromRegistry(await loadRegistry(paths));

      expect(classifier).toBeInstanceOf(ProvenanceClassifier);
      expect(audits.map(({ type }) => type).sort()).toEqual([
        "registry-malformed-line",
        "send-into-unregistered-session",
      ]);

      const dispatch = classifier.handle(
        userMessage("sess-a", "Build the provenance classifier.", iso(1_000)),
      );
      expect(dispatch.record).toMatchObject({ author: "hermes", via: "dispatch-prompt" });

      const send = classifier.handle(
        userMessage("sess-a", "how is it going?", iso(61_000)),
      );
      expect(send.record).toMatchObject({ author: "hermes", via: "registry-send" });

      const johan = classifier.handle(
        userMessage("sess-a", "pause — read this first", iso(90_000)),
      );
      expect(johan.record).toMatchObject({ author: "johan", via: "takeover" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
