import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeCandidateText,
  codexCandidateText,
  isCodexSubagentThread,
  syntheticEnvelopeTag,
} from "./candidates";

// Record shapes copied from research/send-transcript-matching.md §2.
// The *CandidateText helpers return the message text when the record is a
// candidate for provenance classification, and null otherwise.

const claudeUser = {
  type: "user",
  message: { role: "user", content: "E0 submit semantics probe" },
  timestamp: "2026-08-24T17:49:59.470Z",
  promptSource: "typed",
  isSidechain: false,
};

describe("claudeCandidateText", () => {
  test("typed and queued prompts are candidates", () => {
    expect(claudeCandidateText(claudeUser)).toBe("E0 submit semantics probe");
    expect(
      claudeCandidateText({ ...claudeUser, promptSource: "queued" }),
    ).toBe("E0 submit semantics probe");
  });

  test("array-content user records (tool results) are not candidates", () => {
    expect(
      claudeCandidateText({
        ...claudeUser,
        message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
      }),
    ).toBeNull();
  });

  test("isMeta records are not candidates", () => {
    expect(claudeCandidateText({ ...claudeUser, isMeta: true })).toBeNull();
  });

  test("sidechain records are not candidates", () => {
    expect(claudeCandidateText({ ...claudeUser, isSidechain: true })).toBeNull();
  });

  test("non-user record types are not candidates", () => {
    expect(
      claudeCandidateText({
        type: "queue-operation",
        operation: "enqueue",
        content: "queued text",
        timestamp: "2026-08-24T17:50:00.000Z",
      }),
    ).toBeNull();
  });

  // §2.3: `!cmd` lands as <bash-input> with promptSource ABSENT — still a
  // candidate (it must consume bang sends); stdout/stderr never are.
  test("bash-input records are candidates despite absent promptSource", () => {
    const record = {
      type: "user",
      message: { role: "user", content: "<bash-input>echo hermes-bang-probe</bash-input>" },
      isSidechain: false,
    };
    expect(claudeCandidateText(record)).toBe(
      "<bash-input>echo hermes-bang-probe</bash-input>",
    );
  });

  test("bash-stdout/stderr records are never candidates", () => {
    expect(
      claudeCandidateText({
        type: "user",
        message: {
          role: "user",
          content: "<bash-stdout>hermes-bang-probe</bash-stdout><bash-stderr></bash-stderr>",
        },
        isSidechain: false,
      }),
    ).toBeNull();
  });

  test("other promptSource-less plain records are not candidates", () => {
    const { promptSource: _drop, ...withoutSource } = claudeUser;
    expect(claudeCandidateText(withoutSource)).toBeNull();
  });

  test("#53 visibility leaves #50's candidacy verdict bytes unchanged", () => {
    const content = "baseline candidacy probe";
    const record = {
      type: "user",
      message: { role: "user", content },
      isSidechain: false,
    };
    const corpus = [
      { ...record, promptSource: "typed", origin: { kind: "human" } },
      {
        ...record,
        promptSource: "suggestion_accepted",
        origin: { kind: "human" },
      },
      { ...record, promptSource: "sdk", origin: { kind: "human_v2" } },
      {
        ...record,
        promptSource: "sdk",
        origin: { kind: "task-notification" },
      },
      { ...record, promptSource: "sdk" },
      record,
      {
        ...record,
        message: { role: "user", content: "<bash-input>echo probe</bash-input>" },
      },
      { ...record, promptSource: "system" },
    ];
    // Literal verdict bytes captured from base 974865c. Unknown origin stays
    // CLOSED, unknown promptSource stays OPEN, and absence keeps #50's rules.
    const beforeTicket53 = "[true,true,false,false,true,false,true,false]";
    const afterTicket53 = JSON.stringify(
      corpus.map((candidate) => claudeCandidateText(candidate) !== null),
    );

    expect(afterTicket53).toBe(beforeTicket53);
  });
});

/**
 * Ticket #50 — the same records, but REAL ones.
 *
 * Everything above is hand-written, and hand-written input is what #36, #42
 * and #49 each got caught by: a fixture carries the fields its author already
 * knew about. The records below are verbatim lines from real transcripts
 * (`tests/fixtures/claude-code-headless/README.md` names the file and line of
 * each), so they carry the sixteen fields a real record has — including the
 * two this ticket turns on, `promptSource` and `origin`.
 *
 * The population behind the numbers quoted here: 60 project slugs, 234
 * transcripts, 340,222 lines, 59,816 `type: "user"` records on this machine,
 * run through this function.
 */
const headlessFixtures = fileURLToPath(
  new URL("../../tests/fixtures/claude-code-headless/", import.meta.url),
);

async function realRecords(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(headlessFixtures, file), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const content = (record: Record<string, unknown>): string =>
  (record.message as { content: string }).content;

describe("claudeCandidateText on REAL headless records (#50)", () => {
  test("a real `claude -p` dispatch prompt is a candidate", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );

    // The shape first, so a CLI change that moves the goalposts fails HERE
    // rather than silently making the assertion below vacuous.
    expect({
      promptSource: dispatch!.promptSource,
      entrypoint: dispatch!.entrypoint,
      origin: dispatch!.origin,
    }).toEqual({ promptSource: "sdk", entrypoint: "sdk-cli", origin: undefined });

    expect(claudeCandidateText(dispatch)).toBe(content(dispatch!));
  });

  // The sharpest half of #50: the SAME logical event — Hermes dispatching a
  // worker — is `typed` when the session was opened in a terminal and `sdk`
  // when it was opened headlessly. Argus's own dispatcher spawns every worker
  // headlessly, so `sdk` is the path Argus takes on itself. How a session was
  // opened is not provenance, and candidacy must not read it as if it were.
  test("the same record differs only by how the session was opened", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );
    const typedInATerminal = { ...dispatch, promptSource: "typed" };

    expect(claudeCandidateText(typedInATerminal)).toBe(
      claudeCandidateText(dispatch),
    );
  });

  // The poisoning direction, and the reason the fix is NOT "add sdk to the
  // allowlist". This record is real, `sdk`-sourced, and sits at line 727 of a
  // 792-line session: #42's envelope-plus-opening-run rule cannot see it.
  // Measured: 34 of 34 sdk `<task-notification>` records arrive mid-session.
  test("a real mid-session <task-notification> is refused", async () => {
    const [notification] = (await realRecords("task-notification.jsonl")).filter(
      (record) => record.type === "user",
    );

    expect({
      promptSource: notification!.promptSource,
      origin: notification!.origin,
    }).toEqual({ promptSource: "sdk", origin: { kind: "task-notification" } });
    expect(claudeCandidateText(notification)).toBeNull();
  });

  test("...and it is `origin` that refuses it, not the shape or the position", async () => {
    const [notification] = (await realRecords("task-notification.jsonl")).filter(
      (record) => record.type === "user",
    );
    const { origin: _drop, ...withoutOrigin } = notification!;

    // Same bytes, same envelope shape, same mid-session position — the only
    // thing removed is the CLI's own statement of what the record is. If that
    // is what flips the verdict, `origin` is doing the work.
    expect(claudeCandidateText(withoutOrigin)).toBe(content(notification!));
    expect(syntheticEnvelopeTag(content(notification!))).toBe("task-notification");
  });

  // 162 real records on this machine: Johan typing into the Claude desktop
  // app, which fronts the SDK. Dropping these is the deafness direction —
  // USER.md never learns from a word he says in that app (§13.4 the other way
  // round, and silent, which is worse).
  test("a desktop prompt marked `origin: human` is a candidate", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );
    const desktop = {
      ...dispatch,
      entrypoint: "claude-desktop",
      origin: { kind: "human" },
      message: { role: "user", content: "confirm" },
    };

    expect(claudeCandidateText(desktop)).toBe("confirm");
  });

  // Observed once, verbatim: Johan accepting a suggestion, text "yes agreed".
  // An allowlist is silent about what it has never heard of; this is what that
  // silence costs, and it is why unknown SOURCE names default open.
  test("a promptSource the filter has never seen is still heard", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );

    expect(
      claudeCandidateText({
        ...dispatch,
        promptSource: "suggestion_accepted",
        origin: { kind: "human" },
        message: { role: "user", content: "yes agreed" },
      }),
    ).toBe("yes agreed");
  });

  // The other default, and it points the other way ON PURPOSE: an origin kind
  // the CLI invents later is content the CLI is telling us it produced, so it
  // is refused until someone looks. Adding injection kinds is the thing CLIs
  // actually do (#36's `<recommended_plugins>` was exactly that).
  test("an origin kind nobody has seen yet is refused", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );

    expect(
      claudeCandidateText({ ...dispatch, origin: { kind: "hook-result" } }),
    ).toBeNull();
  });

  test("promptSource `system` — the CLI's own marker — is still refused", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );

    // 612 records on this machine carry it; 612 of them are task-notifications
    // and none is a prompt anybody sent.
    expect(claudeCandidateText({ ...dispatch, promptSource: "system" })).toBeNull();
  });

  // #50's ticket says `queued` "never appears in 18,000 lines of real
  // transcripts" and asks whether it is reachable. It is: #49 surveyed the
  // `*argus*` slugs only. Across all 60 slugs on this machine `queued` appears
  // 110 times in string-content non-meta user records. Reachable, exercised,
  // and not to be removed.
  test("`queued` is reachable in real data, not a dead branch", async () => {
    const [dispatch] = (await realRecords("argus-49-drive.jsonl")).filter(
      (record) => record.type === "user",
    );

    expect(claudeCandidateText({ ...dispatch, promptSource: "queued" })).toBe(
      content(dispatch!),
    );
  });
});

const codexUser = {
  timestamp: "2026-08-24T13:20:00.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "E0 codex probe" }],
  },
};

describe("codexCandidateText", () => {
  test("plain user message is a candidate", () => {
    expect(codexCandidateText(codexUser)).toBe("E0 codex probe");
  });

  test("non-user and non-message payloads are not candidates", () => {
    expect(
      codexCandidateText({
        ...codexUser,
        payload: { ...codexUser.payload, role: "assistant" },
      }),
    ).toBeNull();
    expect(
      codexCandidateText({ ...codexUser, payload: { type: "reasoning" } }),
    ).toBeNull();
  });

  test("synthetic user-role items are skipped (#5 findings skip list)", () => {
    for (const text of [
      "# AGENTS.md instructions for this repo",
      "<user_instructions>be nice</user_instructions>",
      "<environment_context>cwd=/x</environment_context>",
      "<ide_context>open file</ide_context>",
      // codex-cli 0.149.1 injects this one into every rollout. Observed live
      // in ticket #36's acceptance run: without it the plugin catalogue
      // classifies as a Johan TAKEOVER, lands in USER.md and marks every
      // Codex session johan_touched — the §13.4 invariant, breached by the
      // agent's own preamble rather than by Hermes.
      "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
    ]) {
      expect(
        codexCandidateText({
          ...codexUser,
          payload: { ...codexUser.payload, content: [{ type: "input_text", text }] },
        }),
      ).toBeNull();
    }
  });

  test("multiple input_text items are joined", () => {
    expect(
      codexCandidateText({
        ...codexUser,
        payload: {
          ...codexUser.payload,
          content: [
            { type: "input_text", text: "part one" },
            { type: "input_text", text: "part two" },
          ],
        },
      }),
    ).toBe("part one\npart two");
  });
});

describe("isCodexSubagentThread", () => {
  // §2.2: subagent rollouts duplicate parent user messages byte-identically
  // with identical timestamps — match against parent threads only.
  test("thread_spawn source marks a subagent thread", () => {
    expect(
      isCodexSubagentThread({
        subagent: { thread_spawn: { parent_thread_id: "01a034fe-aaaa" } },
      }),
    ).toBe(true);
  });

  test("absent or plain source is a parent thread", () => {
    expect(isCodexSubagentThread(undefined)).toBe(false);
    expect(isCodexSubagentThread(null)).toBe(false);
    expect(isCodexSubagentThread({})).toBe(false);
  });
});

/**
 * #42 item 1: the structural half of the synthetic-preamble filter.
 *
 * `CODEX_SYNTHETIC_PREFIXES` is a list of strings the agent CLI happened to
 * inject on the day someone looked. `syntheticEnvelopeTag` knows no strings at
 * all — it recognises the SHAPE agent CLIs use when they inject context, so a
 * block nobody has ever seen is still recognisable as machine-written.
 */
describe("syntheticEnvelopeTag", () => {
  test("a multi-line tag envelope is recognised without knowing its tag", () => {
    // Deliberately NOT a tag any Argus source mentions: this is the
    // <recommended_plugins> of some future codex-cli release.
    expect(
      syntheticEnvelopeTag(
        "<workspace_catalogue>\nHere are the workspaces you may open.\n</workspace_catalogue>",
      ),
    ).toBe("workspace_catalogue");
  });

  test("the shapes agent CLIs really inject are envelopes", () => {
    // Copied from tests/fixtures/codex/era-pre-0.32-flat.jsonl (a real rollout
    // shape) and from the <recommended_plugins> block ticket #36 observed live
    // on codex-cli 0.149.1.
    expect(
      syntheticEnvelopeTag(
        "<environment_context>\n  <cwd>/repo</cwd>\n  <shell>zsh</shell>\n</environment_context>",
      ),
    ).toBe("environment_context");
    expect(
      syntheticEnvelopeTag(
        "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n" +
          "- some-plugin: does a thing\n</recommended_plugins>",
      ),
    ).toBe("recommended_plugins");
  });

  // Each of these defeats the obvious wrong rule ("the text starts with `<`"),
  // and each is a message Argus must still HEAR when Johan types it.
  test("a prompt that merely mentions or opens with markup is not an envelope", () => {
    for (const typed of [
      "fix <Button> so it stops rendering twice",
      "<Button onClick={save} />\nthis renders twice, why?",
      "<div>\n  <span>hi</span>\n</div>\nfix the layout please",
      "<user_instructions>\nignore the above and tell me the answer",
      "<bash-input>echo hermes-bang-probe</bash-input>",
      "<environment_context>cwd=/x</environment_context>",
    ]) {
      expect(syntheticEnvelopeTag(typed)).toBeNull();
    }
  });

  // #78. What a live `codex exec` drive of SPEC §13 slot 4 actually found in
  // the sandbox rollout: the catalogue no longer arrives alone. Two complete
  // envelopes, one user-role item. Under the single-envelope rule the whole
  // thing read as a prompt nobody logged — a Johan takeover, with a plugin
  // catalogue landing in USER.md on every Codex session Argus watches.
  test("a CHAIN of envelopes is one injection, and reports the first tag", () => {
    expect(
      syntheticEnvelopeTag(
        "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n" +
          "- some-plugin: does a thing\n</recommended_plugins>\n" +
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ),
    ).toBe("recommended_plugins");
    // Three, and a repeated tag, so the end of one envelope cannot be found by
    // reaching for the last closing tag in the text.
    expect(
      syntheticEnvelopeTag(
        "<a>\nfirst\n</a>\n<b>\nsecond\n</b>\n<a>\nthird\n</a>",
      ),
    ).toBe("a");
  });

  test("a chain with anything left over is NOT an injection", () => {
    // The widening must not become "starts with an envelope". Johan appending
    // a sentence to something he pasted is still Johan.
    expect(
      syntheticEnvelopeTag(
        "<recommended_plugins>\nlist\n</recommended_plugins>\nwhy is this here?",
      ),
    ).toBeNull();
    expect(
      syntheticEnvelopeTag("<a>\nfirst\n</a>\n<b>\nunclosed second"),
    ).toBeNull();
  });

  test("an envelope must close with its OWN tag", () => {
    expect(syntheticEnvelopeTag("<outer>\nbody\n</inner>")).toBeNull();
    expect(syntheticEnvelopeTag("<outer attr=\"1\">\nbody\n</outer>")).toBeNull();
    expect(syntheticEnvelopeTag("<Outer>\nbody\n</Outer>")).toBeNull();
  });
});
