import { describe, expect, test } from "bun:test";
import { CURATOR_OUTPUT_SCHEMA, parseCuratorVerdict } from "./schema";

const verdict = (body: object): string => JSON.stringify(body);

describe("the curator brain's output contract", () => {
  test("a well-formed verdict parses, absent lists default to empty", () => {
    const parsed = parseCuratorVerdict(
      verdict({ summary: "nothing to do", consolidations: [], prunings: [] }),
    );
    expect(parsed).toEqual({
      summary: "nothing to do",
      consolidations: [],
      prunings: [],
      memory: { merges: [], prunings: [] },
    });
  });

  test("a consolidation may carry the merged umbrella body it wants written", () => {
    const parsed = parseCuratorVerdict(
      verdict({
        summary: "folded a narrow sibling in",
        consolidations: [
          {
            from: "deploy-staging",
            into: "deploy",
            reason: "one skill with N subsections",
            body: "# Deploy\n\n## Staging\n…",
          },
        ],
        prunings: [{ name: "dead-ritual", reason: "180 days idle" }],
        memory: {
          merges: [{ from: "metro-8082", into: "metro-port", reason: "duplicate" }],
          prunings: [{ slug: "old-ip", reason: "superseded" }],
        },
      }),
    );
    expect(parsed!.consolidations[0]!.body).toContain("## Staging");
    expect(parsed!.memory.merges[0]!.into).toBe("metro-port");
    expect(parsed!.memory.prunings[0]!.slug).toBe("old-ip");
  });

  test("anything that is not the contract is a schema miss (null), so the eye retries", () => {
    expect(parseCuratorVerdict("not json")).toBeNull();
    expect(parseCuratorVerdict(verdict({ consolidations: [] }))).toBeNull();
    expect(
      parseCuratorVerdict(verdict({ summary: "x", prunings: [{ reason: "no name" }] })),
    ).toBeNull();
    expect(
      parseCuratorVerdict(
        verdict({ summary: "x", consolidations: [{ from: " ", into: "a", reason: "r" }] }),
      ),
    ).toBeNull();
  });

  test("a skill may not be both consolidated and pruned — exactly one list", () => {
    expect(
      parseCuratorVerdict(
        verdict({
          summary: "x",
          consolidations: [{ from: "twice", into: "umbrella", reason: "r" }],
          prunings: [{ name: "twice", reason: "r" }],
        }),
      ),
    ).toBeNull();
  });

  test("a skill may not be consolidated into itself", () => {
    expect(
      parseCuratorVerdict(
        verdict({
          summary: "x",
          consolidations: [{ from: "self", into: "self", reason: "r" }],
        }),
      ),
    ).toBeNull();
  });

  test("model chatter outside the contract is ignored, not fatal", () => {
    const parsed = parseCuratorVerdict(
      verdict({ summary: "x", prunings: [], notes: "I also thought about…" }),
    );
    expect(parsed!.summary).toBe("x");
  });

  test("a null body means the umbrella's own text is unchanged", () => {
    const parsed = parseCuratorVerdict(
      verdict({
        summary: "x",
        consolidations: [{ from: "a", into: "b", reason: "r", body: null }],
      }),
    );
    expect(parsed!.consolidations[0]!.body).toBeUndefined();
  });

  test("the schema rides codex exec --output-schema", () => {
    expect(CURATOR_OUTPUT_SCHEMA.required).toContain("summary");
    expect(Object.keys(CURATOR_OUTPUT_SCHEMA.properties).sort()).toEqual([
      "consolidations",
      "memory",
      "prunings",
      "summary",
    ]);
  });

  test("every property is in its object's `required` — strict mode rejects less", () => {
    const walk = (node: Record<string, unknown>, path: string): void => {
      if (node.type === "object") {
        const properties = Object.keys(
          (node.properties ?? {}) as Record<string, unknown>,
        ).sort();
        expect([path, [...((node.required as string[] | undefined) ?? [])].sort()]).toEqual([
          path,
          properties,
        ]);
        for (const [key, child] of Object.entries(
          (node.properties ?? {}) as Record<string, Record<string, unknown>>,
        )) {
          walk(child, `${path}.${key}`);
        }
      }
      if (node.type === "array" && node.items) {
        walk(node.items as Record<string, unknown>, `${path}[]`);
      }
    };
    walk(CURATOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>, "root");
  });
});
