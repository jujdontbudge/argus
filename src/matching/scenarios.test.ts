import { describe, expect, test } from "bun:test";
import { claudeCandidateText, isCodexSubagentThread } from "./candidates";
import { SendMatcher } from "./matcher";

// Acceptance scenarios for ticket #24, mapping SPEC §13 scenarios 4 and 5 and
// the ticket's edge-case list onto the pure library. The full end-to-end
// versions run in the fake-Johan harness; these assert the library-level
// contract those scenarios rely on. All state is in-memory (SPEC §13 policy).

const T0 = "2026-08-24T12:00:00.000Z";
const t0 = Date.parse(T0);
const at = (offsetMs: number) => t0 + offsetMs;

describe("SPEC §13 scenario 4 — the poisoning test", () => {
  test("registry-logged nudges classify Hermes; Johan's own words stay Johan", () => {
    const m = new SendMatcher();
    // Hermes logs, then sends, three nudges into a session.
    m.addSend({ ts: T0, text: "run the tests again" });
    m.addSend({ ts: at(60_000), text: "/caveman summarize progress" });
    m.addSend({ ts: at(120_000), text: "!git status" });

    // Each landing classifies Hermes → USER.md never sees them.
    expect(m.classify({ text: "run the tests again", ts: at(900) }).author).toBe(
      "hermes",
    );
    expect(
      m.classify({
        text: "<command-message>caveman</command-message>\n<command-name>/caveman</command-name>\n<command-args>summarize progress</command-args>",
        ts: at(61_000),
      }).author,
    ).toBe("hermes");
    expect(
      m.classify({ text: "<bash-input>git status</bash-input>", ts: at(121_000) })
        .author,
    ).toBe("hermes");

    // Johan interjecting mid-run still reads as Johan.
    expect(
      m.classify({ text: "actually, prioritize the auth bug", ts: at(90_000) })
        .author,
    ).toBe("johan");
    expect(m.pendingCount()).toBe(0);
  });
});

describe("SPEC §13 scenario 5 — the unlogged send", () => {
  test("an unlogged send is visibly Johan, never silently absorbed", () => {
    const m = new SendMatcher();
    // Hermes bypasses the registry (the injected fault): no addSend.
    const r = m.classify({ text: "sneaky unlogged nudge", ts: at(1_000) });
    // The failure mode is VISIBLE: the message surfaces as Johan-authored
    // (poisoning the harness then asserts on), not dropped or hidden.
    expect(r.author).toBe("johan");
  });

  test("a logged send that never lands is loud at expiry", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "eaten by a modal panel", id: "s-modal" });
    const events = m.sweepExpired(at(3_600_001));
    expect(events).toHaveLength(1);
    expect(events[0]!.send.id).toBe("s-modal");
  });
});

describe("ticket #24 edge cases", () => {
  test("per-agent newline encodings: CRLF logged vs LF landed still match", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "step one\r\nstep two" });
    expect(m.classify({ text: "step one\nstep two", ts: at(700) }).author).toBe(
      "hermes",
    );
  });

  test("merged rapid sends match nothing and both expire loudly", () => {
    const m = new SendMatcher();
    // Protocol violation: two sends, one Enter → one concatenated landing.
    m.addSend({ ts: T0, text: "E6 part one.", id: "s1" });
    m.addSend({ ts: at(200), text: " E6 part two.", id: "s2" });
    const merged = m.classify({ text: "E6 part one.  E6 part two.", ts: at(1_000) });
    expect(merged.author).toBe("johan"); // the misclassification surfaces…
    const events = m.sweepExpired(at(3_600_201));
    // …and both stale registry entries audit loudly instead of vanishing.
    expect(events.map((e) => e.send.id).sort()).toEqual(["s1", "s2"]);
  });

  test("Codex subagent byte-identical duplicates never reach the matcher", () => {
    // The tailer consults isCodexSubagentThread before feeding messages; the
    // duplicate thread is excluded wholesale, so the send is consumed exactly
    // once and the copy cannot burn a second entry or fake a Johan message.
    const parentSource = undefined;
    const subagentSource = {
      subagent: { thread_spawn: { parent_thread_id: "01a034fe-parent" } },
    };
    expect(isCodexSubagentThread(parentSource)).toBe(false);
    expect(isCodexSubagentThread(subagentSource)).toBe(true);

    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "implement the parser" });
    // Only the parent thread's copy is classified:
    expect(m.classify({ text: "implement the parser", ts: at(800) }).author).toBe(
      "hermes",
    );
    expect(m.pendingCount()).toBe(0);
  });

  test("Johan coincidentally typing a pending send's text: accepted false-Hermes", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "continue" });
    // Johan's identical message arrives first and is absorbed (tie-break →
    // Hermes, by design: a miss is recoverable, poison is not)…
    expect(m.classify({ text: "continue", ts: at(400) }).author).toBe("hermes");
    // …consumption then lets Hermes' own landing fall through to Johan:
    // net effect is one missed Johan fact and zero USER.md poison.
    expect(m.classify({ text: "continue", ts: at(900) }).author).toBe("johan");
  });

  test("slash send through the matcher: XML landing consumes, literal also accepted", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "/plan refactor the tailer", kind: "slash" });
    const r = m.classify({
      text: "<command-message>plan</command-message>\n<command-name>/plan</command-name>\n<command-args>refactor the tailer</command-args>",
      ts: at(1_100),
    });
    expect(r.author).toBe("hermes");
  });

  test("bash output records are never candidates, so they cannot consume sends", () => {
    expect(
      claudeCandidateText({
        type: "user",
        message: {
          role: "user",
          content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>",
        },
        isSidechain: false,
      }),
    ).toBeNull();
  });
});
