import { describe, expect, test } from "bun:test";
import { parseVerdict, REVIEWER_OUTPUT_SCHEMA } from "./schema";

describe("reviewer verdict schema (luna output contract)", () => {
  test("a schema-conforming verdict parses into typed findings", () => {
    const verdict = parseVerdict(
      JSON.stringify({
        findings: [
          {
            kind: "user-preference",
            slug: "prefers-tabs",
            title: "Prefers tabs",
            content: "Johan prefers tabs over spaces.",
            sources: ["uuid-1"],
          },
          {
            kind: "project-fact",
            slug: "metro-port",
            title: "Metro port",
            content: "Metro runs on 8082.",
            sources: ["uuid-2", "uuid-3"],
          },
          {
            kind: "procedure",
            slug: "release-hotfix",
            title: "Release a hotfix",
            content: "1. branch 2. fix 3. tag",
            sources: [],
          },
        ],
      }),
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.findings.length).toBe(3);
    expect(verdict!.findings[0]!.kind).toBe("user-preference");
    expect(verdict!.findings[1]!.sources).toEqual(["uuid-2", "uuid-3"]);
  });

  test("nothing durable is a valid verdict", () => {
    expect(parseVerdict('{"findings":[]}')).toEqual({ findings: [] });
  });

  test.each([
    ["not JSON at all", "the model rambled"],
    ["findings missing", "{}"],
    ["findings not an array", '{"findings":"none"}'],
    ["unknown kind", '{"findings":[{"kind":"vibe","slug":"a","title":"t","content":"c","sources":[]}]}'],
    ["missing content", '{"findings":[{"kind":"procedure","slug":"a","title":"t","sources":[]}]}'],
    ["non-string source", '{"findings":[{"kind":"project-fact","slug":"a","title":"t","content":"c","sources":[42]}]}'],
  ])("schema miss (%s) → null, so the eye retries", (_name, text) => {
    expect(parseVerdict(text)).toBeNull();
  });

  test("slugs are normalized to kebab-case rather than rejected", () => {
    const verdict = parseVerdict(
      JSON.stringify({
        findings: [
          {
            kind: "project-fact",
            slug: "Metro Port 8082!",
            title: "t",
            content: "c",
            sources: [],
          },
        ],
      }),
    );
    expect(verdict!.findings[0]!.slug).toBe("metro-port-8082");
  });

  test("a slug that normalizes to nothing is a schema miss", () => {
    expect(
      parseVerdict(
        '{"findings":[{"kind":"project-fact","slug":"!!!","title":"t","content":"c","sources":[]}]}',
      ),
    ).toBeNull();
  });

  test("the --output-schema contract constrains kinds and requires every field", () => {
    const schema = REVIEWER_OUTPUT_SCHEMA as {
      required: string[];
      properties: {
        findings: {
          items: {
            required: string[];
            properties: { kind: { enum: string[] } };
          };
        };
      };
    };
    expect(schema.required).toEqual(["findings"]);
    expect(schema.properties.findings.items.required.sort()).toEqual(
      ["content", "kind", "slug", "sources", "title"],
    );
    expect(schema.properties.findings.items.properties.kind.enum.sort()).toEqual(
      ["procedure", "project-fact", "user-preference"],
    );
  });
});
