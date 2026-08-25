import { describe, expect, test } from "bun:test";
import type { RogueChanges } from "./attribution";
import { composeRetro, MAX_BODY_BYTES, type RetroPrompt } from "./compose";
import type { RetroSignal } from "./signal";

const changes: RogueChanges = {
  dir: "/repo",
  commits: [
    {
      sha: "abc1234def567890abc1234def567890abc12345",
      authorName: "Johan Sardar",
      authorEmail: "johansardar77@gmail.com",
      ts: "2026-08-24T12:05:00Z",
      subject: "add the frobnicator",
      body: "",
      files: ["src/frobnicator.ts"],
      diff: "--- /dev/null\n+++ b/src/frobnicator.ts\n+export const frobnicate = () => {};",
    },
  ],
  workingTree: null,
  sessionIds: ["sess-rogue"],
  referencedTickets: [],
  sessionTickets: [],
};

const signal: RetroSignal = {
  id: "retro-0123456789abcdef",
  sources: ["git", "transcript"],
  dir: "/repo",
  changes,
  sessions: [
    {
      sessionId: "sess-rogue",
      agent: "claude",
      digestFile: "adhoc-sess-rogue.md",
      narrative: "Implemented the frobnicator end to end.",
      johanTouched: true,
    },
  ],
  referencedTickets: [],
  sessionTickets: [],
};

const johanPrompt: RetroPrompt = {
  sessionId: "sess-rogue",
  ts: "2026-08-24T12:00:00Z",
  text: "just add a frobnicator to the widget module, don't bother with a ticket",
  author: "johan",
};

function compose(overrides: Parameters<typeof composeRetro>[0] extends infer T
  ? Partial<T>
  : never = {}) {
  return composeRetro({
    what: "frobnicator implemented with no ticket",
    summary: "A session with no registered ticket added src/frobnicator.ts.",
    signal,
    prompts: [johanPrompt],
    parent: { parent: "15", rule: "session-ticket" },
    repoRoot: "/repo",
    ...overrides,
  });
}

describe("composing the retro ticket (SPEC §5.5: prompts + the diff)", () => {
  test("the title is `Retro: <what>`", () => {
    expect(compose().title).toBe("Retro: frobnicator implemented with no ticket");
  });

  test("a runaway title is capped to what GitHub accepts", () => {
    const title = compose({ what: "x".repeat(500) }).title;
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title.startsWith("Retro: xxx")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });

  test("the body carries Johan's prompts and the diff", () => {
    const { body } = compose();
    expect(body).toContain(
      "just add a frobnicator to the widget module, don't bother with a ticket",
    );
    expect(body).toContain("+export const frobnicate = () => {};");
    expect(body).toContain("```diff");
    expect(body).toContain("src/frobnicator.ts");
    expect(body).toContain("abc1234"); // the commit is cited
  });

  test("the body says how it was detected and how the parent was chosen", () => {
    const { body } = compose();
    expect(body).toContain("Argus Retro eye");
    expect(body).toContain("git");
    expect(body).toContain("transcript");
    expect(body).toContain("sess-rogue");
    expect(body).toContain("session-ticket");
    expect(body).toContain("retro-0123456789abcdef");
  });

  test("ONLY provenance-verified Johan prompts are quoted as Johan's", () => {
    const { body } = compose({
      prompts: [
        johanPrompt,
        {
          sessionId: "sess-rogue",
          ts: "2026-08-24T12:01:00Z",
          text: "HERMES DISPATCH: implement ticket #9 and stop",
          author: "hermes",
        },
        {
          sessionId: "sess-rogue",
          ts: "2026-08-24T12:02:00Z",
          text: "I have implemented the frobnicator.",
          author: "agent",
        },
      ],
    });

    expect(body).toContain("just add a frobnicator");
    expect(body).not.toContain("HERMES DISPATCH");
    expect(body).not.toContain("I have implemented the frobnicator.");
  });

  test("autonomous work with no Johan prompts says so instead of an empty section", () => {
    const { body } = compose({ prompts: [] });
    expect(body).toMatch(/no Johan-authored prompts/i);
  });

  test("the digest narrative rides along as the transcript evidence", () => {
    expect(compose().body).toContain("Implemented the frobnicator end to end.");
  });

  test("uncommitted work is described as uncommitted", () => {
    const { body } = compose({
      signal: {
        ...signal,
        sources: ["git"],
        changes: {
          ...changes,
          commits: [],
          workingTree: { files: ["src/wip.ts"], diff: "+const wip = 1;" },
        },
      },
    });
    expect(body).toMatch(/uncommitted/i);
    expect(body).toContain("src/wip.ts");
    expect(body).toContain("+const wip = 1;");
  });

  test("an enormous diff is truncated so the body always fits GitHub", () => {
    const { body } = compose({
      signal: {
        ...signal,
        changes: {
          ...changes,
          commits: [{ ...changes.commits[0]!, diff: "+x\n".repeat(60_000) }],
        },
      },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(body).toMatch(/truncated/i);
    // Truncation never eats the sections that make the retro readable.
    expect(body).toContain("just add a frobnicator");
  });

  test("a transcript-only signal still composes a complete body", () => {
    const { body } = compose({
      signal: { ...signal, sources: ["transcript"], changes: null, dir: null },
      parent: { parent: null, rule: "root-level" },
    });
    expect(body).toContain("Implemented the frobnicator end to end.");
    expect(body).toContain("root-level");
    expect(body).toMatch(/no git changes/i);
  });
});
