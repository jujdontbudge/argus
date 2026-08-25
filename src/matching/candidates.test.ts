import { describe, expect, test } from "bun:test";
import {
  claudeCandidateText,
  codexCandidateText,
  isCodexSubagentThread,
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
