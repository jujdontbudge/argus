import { describe, expect, test } from "bun:test";
import { buildCuratorPrompt, DRY_RUN_BANNER } from "./prompt";

const input = {
  dryRun: false,
  skills: [
    {
      name: "deploy",
      description: "deploy things",
      relative: "deploy",
      state: "active" as const,
      idleDays: 3,
      useCount: 7,
      viewCount: 2,
      patchCount: 1,
      supportFiles: ["references/vault.md"],
    },
    {
      name: "deploy-staging",
      description: "deploy to staging",
      relative: "deploy-staging",
      state: "stale" as const,
      idleDays: 45,
      useCount: 0,
      viewCount: 0,
      patchCount: 0,
      supportFiles: [],
    },
  ],
  facts: [
    { slug: "metro-port", title: "Metro port", idleDays: 10, indexed: true },
    { slug: "metro-8082", title: "Metro on 8082", idleDays: 12, indexed: true },
  ],
  orphans: [{ kind: "index-without-file" as const, slug: "ghost" }],
};

describe("the curator review prompt (structure lifted: agent/curator.py:344-486)", () => {
  test("every candidate is rendered with the usage stats the judgment rests on", () => {
    const prompt = buildCuratorPrompt(input);
    expect(prompt).toContain("deploy-staging");
    expect(prompt).toContain("stale");
    expect(prompt).toContain("45 days");
    expect(prompt).toContain("use 7");
    expect(prompt).toContain("references/vault.md");
  });

  test("the memory half is present — facts to compact and orphans to flag", () => {
    const prompt = buildCuratorPrompt(input);
    expect(prompt).toContain("metro-8082");
    expect(prompt).toContain("ghost");
    expect(prompt).toContain("index-without-file");
  });

  test("the hard rules survive: never delete, never touch pinned, counters are not evidence", () => {
    const prompt = buildCuratorPrompt(input);
    expect(prompt).toContain("NEVER delete");
    expect(prompt).toContain("pinned");
    expect(prompt.toLowerCase()).toContain("zero usage counters");
  });

  test("the umbrella framing and its bar are stated, not implied", () => {
    const prompt = buildCuratorPrompt(input);
    expect(prompt.toLowerCase()).toContain("umbrella");
    expect(prompt).toContain("N labeled subsections");
  });

  test("the required output names both lists and the exactly-one rule", () => {
    const prompt = buildCuratorPrompt(input);
    expect(prompt).toContain("consolidations");
    expect(prompt).toContain("prunings");
    expect(prompt).toContain("exactly one");
  });

  test("dry run prepends the banner; a real run does not", () => {
    expect(buildCuratorPrompt({ ...input, dryRun: true }).startsWith(DRY_RUN_BANNER)).toBe(
      true,
    );
    expect(buildCuratorPrompt(input)).not.toContain(DRY_RUN_BANNER);
  });

  test("with nothing to judge the prompt still states the empty sections plainly", () => {
    const prompt = buildCuratorPrompt({ dryRun: false, skills: [], facts: [], orphans: [] });
    expect(prompt).toContain("(none)");
  });
});
