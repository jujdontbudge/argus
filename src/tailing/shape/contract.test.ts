/**
 * The canary's own gate (#100). The trap this file exists to avoid is stated
 * in the ticket: a test that feeds today's fixtures and asserts they parse
 * would have passed through all four historical bugs. So every assertion here
 * either feeds an UNFAMILIAR shape and demands the canary notice, or pins a
 * blind spot the canary genuinely has.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DECISION_BEARING,
  driftFrom,
  factKey,
  observeClaudeRecord,
  observeCodexRecord,
  severityOf,
  type ShapeBaseline,
  type ShapeFact,
} from "./contract.ts";
import { loadShapeBaseline } from "./baseline.ts";

/** A baseline standing for "everything this corpus has ever seen", built from records. */
function baselineOf(
  facts: Readonly<Record<string, readonly ShapeFact[]>>,
): ShapeBaseline {
  return {
    capturedAt: "2026-08-26T00:00:00.000Z",
    corpus: {},
    facts: Object.fromEntries(
      Object.entries(facts).map(([source, list]) => [source, list.map(factKey).sort()]),
    ),
    versions: {},
  };
}

const claudeToday = {
  type: "user",
  sessionId: "s1",
  timestamp: "2026-08-26T00:00:00.000Z",
  uuid: "u1",
  cwd: "/tmp/repo",
  version: "2.1.246",
  promptSource: "typed",
  origin: { kind: "human" },
  message: { role: "user", content: "run the gate" },
};

const codexToday = {
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "run the gate" }],
  },
};

const claudeBaseline = baselineOf({ "claude-code": observeClaudeRecord(claudeToday) });
const codexBaseline = baselineOf({ codex: observeCodexRecord(codexToday) });

describe("the canary notices UNKNOWN shape, not known-bad shape (#100)", () => {
  test("a familiar record drifts on nothing — so the assertions below are not vacuous", () => {
    expect(driftFrom(claudeBaseline, "claude-code", observeClaudeRecord(claudeToday))).toEqual([]);
    expect(driftFrom(codexBaseline, "codex", observeCodexRecord(codexToday))).toEqual([]);
  });

  test("a plausible FUTURE Claude record — a field and a promptSource nobody taught us", () => {
    const future = {
      ...claudeToday,
      promptSource: "voice",
      attribution: { confidence: 0.9 },
      message: { role: "user", content: "run the gate" },
    };
    const drift = driftFrom(claudeBaseline, "claude-code", observeClaudeRecord(future));
    const keys = drift.map(factKey);
    expect(keys).toContain("field||attribution");
    expect(keys).toContain("value|promptSource|voice");
    expect(drift.find((d) => d.dimension === "value")?.severity).toBe("decision-bearing");
    expect(drift.find((d) => d.dimension === "field")?.severity).toBe("notice");
    for (const one of drift) expect(one.reason.length).toBeGreaterThan(10);
  });

  test("a plausible FUTURE Codex record — a payload type nobody has modelled", () => {
    const future = {
      type: "response_item",
      payload: {
        type: "compacted_message",
        role: "user",
        summary_of: 12,
        content: [{ type: "input_text_v2", text: "hi", spans: [] }],
      },
    };
    const keys = driftFrom(codexBaseline, "codex", observeCodexRecord(future)).map(factKey);
    expect(keys).toContain("value|payload.type|compacted_message");
    expect(keys).toContain("value|payload.content[].type|input_text_v2");
  });

  test("a new CLI version is itself drift — the contract no longer describes the writer", () => {
    const drift = driftFrom(claudeBaseline, "claude-code", observeClaudeRecord({
      ...claudeToday,
      version: "2.2.0",
    }));
    expect(drift.map(factKey)).toContain("cli-version||2.2.0");
    expect(severityOf("cli-version")).toBe("notice");
  });
});

describe("would it have caught the four? (#36, #50, #78 twice)", () => {
  test("#36 — codex-cli starts injecting <recommended_plugins> as a user-role item: CAUGHT", () => {
    const before = baselineOf({
      codex: [
        ...observeCodexRecord(codexToday),
        ...observeCodexRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>\ncwd\n</environment_context>" }],
          },
        }),
      ],
    });
    const injected = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<recommended_plugins>\nHere is a list of plugins\n</recommended_plugins>",
          },
        ],
      },
    };
    expect(driftFrom(before, "codex", observeCodexRecord(injected)).map(factKey)).toContain(
      "envelope|user-text|recommended_plugins",
    );
  });

  test("#50 — a real Claude record carries `origin`, and `promptSource: sdk`: CAUGHT twice", () => {
    // The pre-#50 corpus: fixtures with five fields and a {typed, queued} door.
    const before = baselineOf({
      "claude-code": observeClaudeRecord({
        type: "user",
        sessionId: "s1",
        timestamp: "2026-08-01T00:00:00.000Z",
        promptSource: "typed",
        message: { role: "user", content: "hello" },
      }),
    });
    const real = {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-08-26T00:00:00.000Z",
      promptSource: "sdk",
      entrypoint: "sdk-cli",
      origin: { kind: "task-notification" },
      message: { role: "user", content: "<task-notification>\ndone\n</task-notification>" },
    };
    const keys = driftFrom(before, "claude-code", observeClaudeRecord(real)).map(factKey);
    expect(keys).toContain("field||origin");
    expect(keys).toContain("value|promptSource|sdk");
    expect(keys).toContain("value|origin.kind|task-notification");
  });

  /**
   * The decomposer as it was BEFORE #78: one complete envelope, or nothing.
   * That is the code that was live when codex-cli started packing two, and it
   * is what makes this claim testable instead of merely asserted.
   */
  const singleEnvelopeOnly = (text: string): string | null => {
    const open = /^<([a-z][a-z0-9_-]*)>\n/.exec(text);
    if (open === null) return null;
    return text.endsWith(`</${open[1]!}>`) ? open[1]! : null;
  };

  test("#78 second — codex packs TWO envelopes into ONE user-role item: CAUGHT", () => {
    // Both tags are already familiar by then; what is new is that the tree's
    // own decomposer no longer recognises the item as an injection at all.
    const packed =
      "<recommended_plugins>\na\n</recommended_plugins>\n<environment_context>\nb\n</environment_context>";
    const before = baselineOf({
      codex: [
        ...observeCodexRecord(codexToday),
        // A pre-#78 single-envelope item of each tag, decomposable then.
        { dimension: "envelope", path: "user-text", token: "recommended_plugins" },
        { dimension: "envelope", path: "user-text", token: "environment_context" },
      ],
    });
    const observed = observeCodexRecord(
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: packed }],
        },
      },
      singleEnvelopeOnly,
    );
    // The pre-#78 decomposer really does refuse the packed item — the premise
    // of this test, checked rather than assumed.
    expect(singleEnvelopeOnly(packed)).toBeNull();
    const keys = driftFrom(before, "codex", observed).map(factKey);
    expect(keys).toContain("undecomposable|user-text|recommended_plugins");
  });

  test("#78 first — a Hermes bang-send landing verbatim: NOT CAUGHT, and pinned as such", () => {
    // `!git log --oneline -3` is an ordinary user-role record in every respect
    // a record-shape canary can see. The bug is a mismatch between a LOGGED
    // SEND and the landed text — the matching layer, not the record shape.
    // This assertion exists so the limitation cannot quietly be forgotten: if
    // a later change makes it fire, that is a claim that needs re-justifying.
    const landed = {
      ...claudeToday,
      message: { role: "user", content: "!git log --oneline -3" },
    };
    expect(driftFrom(claudeBaseline, "claude-code", observeClaudeRecord(landed))).toEqual([]);
  });
});

describe("the captured contract (#89/#97's pattern one level down)", () => {
  const baseline = loadShapeBaseline();

  test("it is captured from a real corpus, not authored — and says how big", () => {
    for (const source of ["claude-code", "codex", "hermes"] as const) {
      expect(baseline.facts[source]?.length ?? 0).toBeGreaterThan(10);
      expect(baseline.corpus[source]?.records ?? 0).toBeGreaterThan(0);
    }
  });

  test("it names the CLI versions it was captured under", () => {
    expect(baseline.versions["claude-code"]?.length ?? 0).toBeGreaterThan(0);
    expect(baseline.versions.codex?.length ?? 0).toBeGreaterThan(0);
  });

  test("today's real record shapes drift on nothing — the control for the whole file", () => {
    expect(driftFrom(baseline, "claude-code", observeClaudeRecord(claudeToday))).toEqual([]);
    expect(driftFrom(baseline, "codex", observeCodexRecord(codexToday))).toEqual([]);
  });
});

describe("the one thing pinned by hand describes THIS repo, and is held to it", () => {
  const sources: Record<string, string> = {
    "claude-code": "src/tailing/claude-code.ts",
    codex: "src/tailing/codex.ts",
    hermes: "src/tailing/hermes.ts",
  };

  test("every decision-bearing path is a field the named parser actually reads", () => {
    const candidates = readFileSync(join(import.meta.dir, "../../matching/candidates.ts"), "utf8");
    for (const [source, paths] of Object.entries(DECISION_BEARING)) {
      const parser = readFileSync(join(import.meta.dir, "../../..", sources[source]!), "utf8");
      for (const path of paths) {
        const leaf = path.replace("[]", "").split(".").at(-1)!;
        expect(
          parser.includes(leaf) || candidates.includes(leaf),
          `${source}: nothing reads '${leaf}' (from '${path}')`,
        ).toBe(true);
      }
    }
  });
});
