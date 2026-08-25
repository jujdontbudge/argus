import { describe, expect, test } from "bun:test";
import { parseRetroVerdict, RETRO_OUTPUT_SCHEMA } from "./schema";

const judgment = {
  signalId: "sig-1",
  implementation: true,
  what: "frobnicator implemented with no ticket",
  summary: "A rogue session added src/frobnicator.ts and committed it.",
  parentTicket: "15",
};

describe("the Retro brain's output contract", () => {
  test("a conforming verdict parses into typed judgments", () => {
    const verdict = parseRetroVerdict(JSON.stringify({ retros: [judgment] }));
    expect(verdict).toEqual({ retros: [judgment] });
  });

  test("parentTicket is nullable — a retro can have no plausible parent", () => {
    const verdict = parseRetroVerdict(
      JSON.stringify({ retros: [{ ...judgment, parentTicket: null }] }),
    );
    expect(verdict!.retros[0]!.parentTicket).toBeNull();
  });

  test("a judgment that found no implementation parses (the eye files nothing)", () => {
    const verdict = parseRetroVerdict(
      JSON.stringify({
        retros: [{ ...judgment, implementation: false, what: "", parentTicket: null }],
      }),
    );
    expect(verdict!.retros[0]!.implementation).toBe(false);
  });

  test("non-JSON, wrong shapes and wrong types are schema misses (null → retry)", () => {
    expect(parseRetroVerdict("not json")).toBeNull();
    expect(parseRetroVerdict(JSON.stringify({ retros: {} }))).toBeNull();
    expect(parseRetroVerdict(JSON.stringify({}))).toBeNull();
    expect(
      parseRetroVerdict(JSON.stringify({ retros: [{ ...judgment, signalId: 7 }] })),
    ).toBeNull();
    expect(
      parseRetroVerdict(
        JSON.stringify({ retros: [{ ...judgment, implementation: "yes" }] }),
      ),
    ).toBeNull();
    expect(
      parseRetroVerdict(JSON.stringify({ retros: [{ ...judgment, parentTicket: 15 }] })),
    ).toBeNull();
    expect(parseRetroVerdict(JSON.stringify({ retros: [{ signalId: "sig-1" }] }))).toBeNull();
  });

  test("an empty retro list is a valid verdict — nothing rogue happened", () => {
    expect(parseRetroVerdict(JSON.stringify({ retros: [] }))).toEqual({ retros: [] });
  });

  test("the schema rides codex --output-schema with every field required", () => {
    const properties = RETRO_OUTPUT_SCHEMA.properties.retros.items;
    expect(properties.required).toEqual([
      "signalId",
      "implementation",
      "what",
      "summary",
      "parentTicket",
    ]);
    expect(properties.additionalProperties).toBe(false);
  });
});
