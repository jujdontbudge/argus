import { describe, expect, test } from "bun:test";
import {
  buildExtractionPrompt,
  buildProcedurePrompt,
  type ProvenanceRecord,
} from "./reviewer";
import {
  EXTRACTION_OUTPUT_SCHEMA,
  PROCEDURE_OUTPUT_SCHEMA,
  parseVerdict,
} from "./schema";

/**
 * Tickets #69 and #71 — the Reviewer's two prompts, pinned as a contract.
 *
 * #69: extraction and procedure-writing are different cognitive tasks and
 * #54 measured that the brain does the first reliably and the second not at
 * all (S3 failed identically at every tier). The prompts must not conflate
 * them, and the extraction pass — the one that writes durable memory — must
 * not be able to emit a procedure at all.
 *
 * #71: an observation of how the environment IS is a project fact, never a
 * skill. #54's R4 (`cmux must be >= 0.64.22`) is the case that measured the
 * misfile.
 */
function record(
  uuid: string,
  author: ProvenanceRecord["author"],
  text: string,
): ProvenanceRecord {
  return {
    sessionId: "sess-1",
    author,
    via: author === "johan" ? "takeover" : "assistant",
    registered: true,
    startedBy: "hermes",
    johanTouched: author === "johan",
    ts: "2026-08-26T12:00:00.000Z",
    text,
    event: {
      type: "message",
      sessionId: "sess-1",
      role: author === "agent" ? "assistant" : "user",
      text,
      ts: "2026-08-26T12:00:00.000Z",
      uuid,
      candidate: author !== "agent",
      file: "/transcripts/sess-1.jsonl",
    },
  };
}

const BATCH = [
  record("uuid-j1", "johan", "always spawn workers as tabs"),
  record("uuid-a1", "agent", "cmux must be >= 0.64.22; this machine is on 0.62.2"),
];

describe("#69 — the extraction prompt does not ask for a transferable procedure", () => {
  const prompt = buildExtractionPrompt(BATCH);

  test("it asks for the two fact kinds and names neither procedures nor skills", () => {
    expect(prompt).toContain("user-preference");
    expect(prompt).toContain("project-fact");
    expect(prompt).not.toMatch(/repeatable procedure worth a reusable skill/i);
    expect(prompt).not.toMatch(/kind "procedure"/i);
  });

  test("it says plainly that this pass extracts and does not generalise", () => {
    expect(prompt).toMatch(/extract/i);
    expect(prompt).toMatch(/do not generali[sz]e/i);
  });

  test("it still carries the batch and the provenance rule", () => {
    expect(prompt).toContain("always spawn workers as tabs");
    expect(prompt).toContain("uuid-a1");
    expect(prompt).toMatch(/author=johan/);
  });

  test("its schema cannot express a procedure", () => {
    const kind = EXTRACTION_OUTPUT_SCHEMA.properties.findings.items.properties.kind;
    expect([...kind.enum]).toEqual(["user-preference", "project-fact"]);
  });
});

describe("#69 — procedure-writing is a separate prompt with its own schema", () => {
  const prompt = buildProcedurePrompt(BATCH);

  test("it asks for the transferable method rather than the episode", () => {
    expect(prompt).toMatch(/transferable/i);
    expect(prompt).toMatch(/not the episode|rather than the episode/i);
  });

  test("it makes silence the default when there is no repeatable how", () => {
    expect(prompt).toMatch(/emit no findings|no findings at all/i);
    expect(prompt).toMatch(/almost always/i);
  });

  test("it names no fact kind — facts are the other pass's job", () => {
    expect(prompt).not.toContain("user-preference");
    expect(prompt).not.toMatch(/kind "project-fact"/);
  });

  test("its schema can express nothing but a procedure", () => {
    const kind = PROCEDURE_OUTPUT_SCHEMA.properties.findings.items.properties.kind;
    expect([...kind.enum]).toEqual(["procedure"]);
  });

  test("it carries the same batch the extraction pass saw", () => {
    expect(prompt).toContain("always spawn workers as tabs");
    expect(prompt).toContain("uuid-j1");
  });
});

describe("#69/#71 — the parse boundary refuses out-of-pass kinds", () => {
  const procedureVerdict = JSON.stringify({
    findings: [
      {
        kind: "procedure",
        slug: "upgrade-cmux",
        title: "Upgrade cmux",
        content: "cmux must be >= 0.64.22",
        sources: ["uuid-a1"],
      },
    ],
  });

  test("an environment fact returned as a procedure by the extraction pass is a schema miss", () => {
    expect(parseVerdict(procedureVerdict, ["user-preference", "project-fact"])).toBeNull();
  });

  test("a fact returned by the procedure pass is a schema miss", () => {
    const factVerdict = JSON.stringify({
      findings: [
        {
          kind: "project-fact",
          slug: "cmux-version",
          title: "cmux version",
          content: "cmux must be >= 0.64.22",
          sources: ["uuid-a1"],
        },
      ],
    });
    expect(parseVerdict(factVerdict, ["procedure"])).toBeNull();
  });

  test("unrestricted parsing is unchanged", () => {
    expect(parseVerdict(procedureVerdict)?.findings).toHaveLength(1);
  });
});
