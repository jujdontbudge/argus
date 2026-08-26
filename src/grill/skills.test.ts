import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRILL_MODES, resolveGrillSkill, type GrillMode } from "./index.ts";

/**
 * Ticket #62 — skill routing, SPEC §1 ("`grilling`, `spec`, `review`,
 * `diagnosis` → Claude Code") and §7.1 (the pocock-plus chain).
 *
 * Routing has two halves and both are asserted here, because getting either
 * one wrong is silent: a mode routed to the wrong AGENT sends planning work to
 * the implementer, and a mode routed to a skill NAME that does not exist opens
 * a session that quietly does something else and looks fine.
 *
 * §8.2's "one store, three readers" decides the precedence: when the repo's
 * canonical `.argus/skills/` carries the skill, that copy wins, because it is
 * the one the Reviewer updates and the curator retires. The plugin id is the
 * fallback, never the override.
 */
async function repoWithCanonicalSkill(name: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-grill-skills-"));
  await mkdir(join(repo, ".argus/skills", name), { recursive: true });
  await writeFile(
    join(repo, ".argus/skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: canonical\n---\n`,
  );
  return repo;
}

describe("resolveGrillSkill (#62): §8.2 canonical store first, plugin second", () => {
  test("every routed mode names a real pocock-plus skill and routes to Claude", () => {
    for (const [mode, route] of Object.entries(GRILL_MODES)) {
      expect(route.agent).toBe("claude");
      expect(route.skill).toMatch(/^pocock-plus:[a-z-]+$/);
      expect(route.skill.slice("pocock-plus:".length)).toBe(route.name);
      expect(mode).not.toBe("");
    }
    // SPEC §7.1's chain, by name, so a rename upstream fails here loudly
    // instead of opening a session on a skill that is not there.
    expect(GRILL_MODES.grilling.skill).toBe("pocock-plus:grilling");
    expect(GRILL_MODES.spec.skill).toBe("pocock-plus:to-spec");
    expect(GRILL_MODES.tickets.skill).toBe("pocock-plus:to-tickets");
  });

  test("the repo's canonical .argus/skills copy wins over the plugin id", async () => {
    const repo = await repoWithCanonicalSkill("grilling");
    try {
      expect(await resolveGrillSkill(repo, "grilling")).toEqual({
        mode: "grilling",
        skill: "grilling",
        source: "argus-canonical",
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("without a canonical copy the plugin id is used, and said out loud", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-grill-skills-"));
    try {
      expect(await resolveGrillSkill(repo, "grilling")).toEqual({
        mode: "grilling",
        skill: "pocock-plus:grilling",
        source: "pocock-plus",
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("an unknown mode is refused rather than routed to a guessed skill", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-grill-skills-"));
    try {
      await expect(
        resolveGrillSkill(repo, "sudo-make-me-a-sandwich" as GrillMode),
      ).rejects.toThrow(/unknown grill mode/);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});
