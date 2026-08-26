import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  createClaudeCodeSource,
  Tailer,
  type MessageEvent,
  type TailEvent,
} from "../tailing/index.ts";
import { ProvenanceClassifier, type ProvenanceRecord } from "./index.ts";

/**
 * Ticket #50 — §5 provenance over a REAL headless Claude transcript.
 *
 * `src/matching/candidates.test.ts` pins the record-level verdict; this file
 * pins the thing the verdict exists for. Real bytes go through the production
 * parser and the production classifier, and what comes out has to be the §5
 * answer: Hermes dispatched this worker.
 *
 * It is the structural twin of the LIVE assertion in
 * `src/harness/subscription-drive.test.ts`. That one needs a subscription call
 * and an open gate; this one runs on every `bun test`, off the same shape,
 * because a drive nothing reminds you to run is a drive that rots (#46).
 */
const fixtureDir = fileURLToPath(
  new URL("../../tests/fixtures/claude-code-headless/", import.meta.url),
);

const isMessage = (event: TailEvent): event is MessageEvent =>
  event.type === "message";

async function realEvents(): Promise<MessageEvent[]> {
  const events = await new Tailer(createClaudeCodeSource({ dir: fixtureDir })).catchUp();
  return events.filter(isMessage);
}

function classifyAll(
  classifier: ProvenanceClassifier,
  events: MessageEvent[],
): Map<MessageEvent, ProvenanceRecord> {
  const records = new Map<MessageEvent, ProvenanceRecord>();
  for (const event of events) {
    const { record } = classifier.handle(event);
    if (record) records.set(event, record);
  }
  return records;
}

describe("a real headless dispatch (#50)", () => {
  test("lands as hermes / dispatch-prompt, not system / non-candidate", async () => {
    const events = await realEvents();
    const dispatch = events.find(
      (event) => event.role === "user" && event.text.includes("ticket #49"),
    );
    expect(dispatch?.promptSource).toBe("sdk");

    // What Hermes logged before the session started (§5 rule 1). The dispatch
    // prompt is the registry's copy of the very text below.
    const classifier = new ProvenanceClassifier();
    classifier.registerSession({
      ts: dispatch!.ts,
      sessionId: dispatch!.sessionId,
      agent: "claude",
      ticket: "49",
      dispatchPrompt: dispatch!.text,
    });

    const records = classifyAll(classifier, events);
    expect({
      author: records.get(dispatch!)?.author,
      via: records.get(dispatch!)?.via,
    }).toEqual({ author: "hermes", via: "dispatch-prompt" });
    // Deafness has a second cost past the lost attribution: the session never
    // registers as touched-by-nobody either, because nothing about it is ever
    // classified. `startedBy` is the Digest's frontmatter (§5.4).
    expect(records.get(dispatch!)?.startedBy).toBe("hermes");
  });

  // The gain, stated as its own assertion because it is bigger than the
  // dispatch case: 292 real prompts on this machine are dropped today, and
  // most of them are Johan's own words in the Claude desktop app (§7.4 gives
  // his ad hoc sessions identical coverage). Unregistered session, real
  // prompt, §5 rule 3a — Johan.
  test("the same prompt in an UNREGISTERED session is Johan, not silence", async () => {
    const events = await realEvents();
    const dispatch = events.find(
      (event) => event.role === "user" && event.text.includes("ticket #49"),
    );

    const records = classifyAll(new ProvenanceClassifier(), events);
    expect({
      author: records.get(dispatch!)?.author,
      via: records.get(dispatch!)?.via,
    }).toEqual({ author: "johan", via: "unregistered-session" });
  });

  // The poisoning direction, on a real record, through the real classifier.
  // This is what the naive fix — accepting `sdk` and leaving the rest alone —
  // would have got wrong: the record is mid-session, so #42's opening-run rule
  // is not looking, and it would have classified as a Johan TAKEOVER of a
  // registered session, flipped `johanTouched`, and gone into USER.md. That is
  // #36's `<recommended_plugins>` failure with a new name.
  test("a real mid-session task-notification never becomes Johan", async () => {
    const events = await realEvents();
    const notification = events.find((event) =>
      event.text.startsWith("<task-notification>"),
    );
    expect(notification?.promptSource).toBe("sdk");

    const classifier = new ProvenanceClassifier();
    classifier.registerSession({
      ts: notification!.ts,
      sessionId: notification!.sessionId,
      agent: "claude",
      ticket: "50",
      dispatchPrompt: "a dispatch this fixture does not contain",
    });

    const records = classifyAll(classifier, events);
    expect({
      author: records.get(notification!)?.author,
      via: records.get(notification!)?.via,
    }).toEqual({ author: "system", via: "non-candidate" });
    expect(records.get(notification!)?.johanTouched).toBe(false);
  });

  test("nothing in either real session is attributed to Johan when both are registered", async () => {
    const events = await realEvents();
    const classifier = new ProvenanceClassifier();
    for (const sessionId of new Set(events.map((event) => event.sessionId))) {
      const first = events.find((event) => event.sessionId === sessionId)!;
      const dispatch = events.find(
        (event) => event.sessionId === sessionId && event.role === "user",
      );
      classifier.registerSession({
        ts: first.ts,
        sessionId,
        agent: "claude",
        dispatchPrompt: dispatch?.text ?? "unused",
      });
    }

    const records = [...classifyAll(classifier, events).values()];
    expect(
      records
        .filter((record) => record.author === "johan")
        .map((record) => record.text.slice(0, 80)),
    ).toEqual([]);
  });
});
