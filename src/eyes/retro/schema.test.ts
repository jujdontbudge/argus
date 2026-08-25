import { describe, expect, test } from "bun:test";
import {
  DRIFT_OUTPUT_SCHEMA,
  parseDriftVerdict,
  parseRetroVerdict,
  RETRO_OUTPUT_SCHEMA,
} from "./schema";

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

describe("the scope-drift contract (#38)", () => {
  const judgment = {
    candidateId: "drift-abc123",
    drift: true,
    confident: true,
    what: "Stripe billing webhooks",
    outOfScopeWork: "Added src/billing/stripe-webhooks.ts and its route table.",
    whyOutOfScope: "The ticket states the widget pipeline; billing is a different goal.",
  };

  test("a well-formed verdict parses", () => {
    expect(parseDriftVerdict(JSON.stringify({ drifts: [judgment] }))).toEqual({
      drifts: [judgment],
    });
  });

  test("the not-drift answer nulls the prose fields rather than omitting them", () => {
    const silent = {
      candidateId: "drift-abc123",
      drift: false,
      confident: true,
      what: null,
      outOfScopeWork: null,
      whyOutOfScope: null,
    };

    expect(parseDriftVerdict(JSON.stringify({ drifts: [silent] }))).toEqual({
      drifts: [silent],
    });
  });

  test("anything off-contract is a schema miss, not a half-trusted verdict", () => {
    expect(parseDriftVerdict("not json")).toBeNull();
    expect(parseDriftVerdict(JSON.stringify({ drifts: {} }))).toBeNull();
    expect(
      parseDriftVerdict(JSON.stringify({ drifts: [{ ...judgment, drift: "yes" }] })),
    ).toBeNull();
    expect(
      parseDriftVerdict(JSON.stringify({ drifts: [{ ...judgment, confident: undefined }] })),
    ).toBeNull();
    expect(
      parseDriftVerdict(JSON.stringify({ drifts: [{ ...judgment, candidateId: "" }] })),
    ).toBeNull();
  });

  test("EVERY property is listed in `required` — an omitted one voids the schema", () => {
    // The #35 lesson: strict structured output rejects an object whose
    // `required` omits a property, and it surfaces only as a bare `exit 1`
    // with empty stderr. Optionality rides the null union instead.
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const schema = node as Record<string, unknown>;
      if (schema.type === "object") {
        const properties = Object.keys(
          (schema.properties ?? {}) as Record<string, unknown>,
        );
        expect([...(schema.required as string[])].sort()).toEqual(properties.sort());
      }
      for (const value of Object.values(schema)) walk(value);
    };

    walk(DRIFT_OUTPUT_SCHEMA);
  });
});
