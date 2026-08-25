import { describe, expect, test } from "bun:test";
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

  test("an envelope must close with its OWN tag", () => {
    expect(syntheticEnvelopeTag("<outer>\nbody\n</inner>")).toBeNull();
    expect(syntheticEnvelopeTag("<outer attr=\"1\">\nbody\n</outer>")).toBeNull();
    expect(syntheticEnvelopeTag("<Outer>\nbody\n</Outer>")).toBeNull();
  });
});
