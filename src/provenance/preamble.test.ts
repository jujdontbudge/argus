/**
 * Ticket #42 item 1 — the test #36 said did not exist.
 *
 * Every transcript fixture in this tree hand-writes CLEAN user turns, which is
 * why 518 green tests never saw codex-cli 0.149.1 inject `<recommended_plugins>`
 * as a user-role rollout item, classify it a §5 takeover, and send a plugin
 * catalogue to USER.md with `johan_touched` set on every Codex session Argus
 * would ever watch.
 *
 * This one drives a DIRTY rollout — the real `CodexSource`, the real `Tailer`,
 * the real classifier — and the block it carries is `<workspace_catalogue>`,
 * a tag that appears in no source file, no filter list and no other test. It
 * fails if the only defence is a list of strings someone remembered to update.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCodexSource, Tailer, type TailEvent } from "../tailing";
import {
  ProvenanceClassifier,
  type ProvenanceAuditEvent,
  type ProvenanceRecord,
} from "./classifier";

const FIXTURE = fileURLToPath(
  new URL("../../tests/fixtures/codex/scenario-injected-preamble.jsonl", import.meta.url),
);

const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000150";
const DISPATCH = "You are a BUILD worker for ticket #42. Implement it, then stop.";
const JOHAN = "stop — ship the auth fix first, then come back";

/** Write the fixture rollout into a scratch CODEX_HOME and tail it for real. */
async function tail(extraLines: readonly string[]): Promise<TailEvent[]> {
  const root = await mkdtemp(join(tmpdir(), "argus-preamble-"));
  try {
    const codexHome = join(root, "codex");
    const rolloutDir = join(codexHome, "sessions/2026/09/01");
    await mkdir(rolloutDir, { recursive: true });
    const body = (await Bun.file(FIXTURE).text())
      .replaceAll("__CWD__", join(root, "repo"))
      .replaceAll("__DISPATCH__", DISPATCH);
    await writeFile(
      join(rolloutDir, `rollout-2026-09-01T10-00-00-${SESSION_ID}.jsonl`),
      [body.trimEnd(), ...extraLines].join("\n") + "\n",
    );
    return await new Tailer(createCodexSource({ codexHome })).catchUp();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function classify(events: readonly TailEvent[]) {
  const classifier = new ProvenanceClassifier();
  classifier.registerSession({
    ts: "2026-09-01T10:00:00.000Z",
    sessionId: SESSION_ID,
    agent: "codex",
    ticket: "42",
    dispatchPrompt: DISPATCH,
  });
  const audits: ProvenanceAuditEvent[] = [];
  const records: ProvenanceRecord[] = [];
  for (const event of events) {
    const output = classifier.handle(event);
    if (output.record) records.push(output.record);
    audits.push(...output.audits);
  }
  return { classifier, records, audits };
}

/** The user-role line a real Johan takeover writes into the same rollout. */
const JOHAN_LINE = JSON.stringify({
  timestamp: "2026-09-01T10:05:00.000Z",
  ordinal: 5,
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: JOHAN }],
  },
});

describe("a rollout carrying an unknown agent-injected block (#42, from #36 F3)", () => {
  test("the injected catalogue never becomes Johan and never touches the session", async () => {
    const { classifier, records, audits } = classify(await tail([]));

    const catalogue = records.find(({ text }) => text.startsWith("<workspace_catalogue>"));
    expect(catalogue).toBeDefined();
    expect(catalogue).toMatchObject({ author: "system", via: "synthetic-preamble" });

    // The §13.4 invariant, stated as the thing that actually broke: nobody
    // typed anything, so nothing is Johan's and the session is untouched.
    expect(records.filter(({ author }) => author === "johan")).toEqual([]);
    expect(classifier.sessionState(SESSION_ID)?.johanTouched).toBe(false);
    expect(audits.some((audit) => audit.type === "johan-attached")).toBe(false);

    // ...and it is LOUD, naming the tag a reader can act on.
    expect(audits).toContainEqual(
      expect.objectContaining({
        type: "synthetic-preamble-suspect",
        sessionId: SESSION_ID,
        tag: "workspace_catalogue",
        classifiedAs: "system",
      }),
    );
  });

  test("a real takeover in the same rollout is still heard, and is the only one", async () => {
    // The other half of the trade: filtering the catalogue must not cost
    // Argus its ears. Johan types into the same session; that is his.
    const { classifier, records } = classify(await tail([JOHAN_LINE]));

    const johan = records.filter(({ author }) => author === "johan");
    expect(johan.map(({ text, via }) => [via, text])).toEqual([["takeover", JOHAN]]);
    expect(classifier.sessionState(SESSION_ID)?.johanTouched).toBe(true);
  });

  test("the dispatch prompt still lands as Hermes' through the same preamble", async () => {
    const { records } = classify(await tail([]));

    expect(records.find(({ text }) => text === DISPATCH)).toMatchObject({
      author: "hermes",
      via: "dispatch-prompt",
      ticket: "42",
    });
  });
});
