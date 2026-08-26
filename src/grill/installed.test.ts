/**
 * Ticket #89 — the routed skill id, resolved against a machine.
 *
 * `skills.test.ts:42-44` asserts `GRILL_MODES.spec.skill` equals the literal
 * `"pocock-plus:to-spec"` it was built from, which is a constant compared to
 * a constant: the upstream rename its docblock warns about cannot fail it.
 * Every case below therefore builds a FAKE plugin tree and a FAKE manifest and
 * asks the resolver about it, so the rename, the uninstall and the
 * slash-only frontmatter are each a real state some machine can be in.
 *
 * The live rendering of this — the same resolver run against THIS machine's
 * `installed_plugins.json`, with the answer written into
 * `docs/acceptance/grill-live.txt` — is `harness/grill-live.ts`. It is not
 * repeated here, because a test that reads the developer's real plugin cache
 * passes or fails for reasons that have nothing to do with this repo.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installedPluginSkills, verifyGrillSkill } from "./installed.ts";
import { GRILL_MODES } from "./skills.ts";

interface FakeSkill {
  category: string;
  name: string;
  slashOnly?: boolean;
}

async function machine(
  skills: readonly FakeSkill[],
  options: { version?: string; qualifier?: string } = {},
): Promise<{ manifest: string; repo: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "argus-grill-skills-"));
  const version = options.version ?? "1.2.3-johan.7";
  const installPath = join(root, "cache", "pocock-plus", version);
  for (const skill of skills) {
    const directory = join(installPath, "skills", skill.category, skill.name);
    await mkdir(directory, { recursive: true });
    const frontmatter = [
      "---",
      `name: ${skill.name}`,
      "description: a fixture skill",
      ...(skill.slashOnly === true ? ["disable-model-invocation: true"] : []),
      "---",
      "",
      "body",
    ].join("\n");
    await Bun.write(join(directory, "SKILL.md"), frontmatter);
  }
  const manifest = join(root, "installed_plugins.json");
  await Bun.write(
    manifest,
    JSON.stringify({
      plugins: {
        [`${options.qualifier ?? "pocock-plus"}@johan-plugins`]: [
          { installPath, scope: "user", version },
        ],
      },
      version: 2,
    }),
  );
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  return { manifest, repo, root };
}

const INSTALLED: readonly FakeSkill[] = [
  { category: "productivity", name: "grilling" },
  { category: "engineering", name: "code-review" },
  { category: "engineering", name: "diagnosing-bugs" },
  { category: "engineering", name: "to-spec" },
  { category: "engineering", name: "to-tickets" },
];

describe("verifyGrillSkill", () => {
  test("resolves a routed id to the SKILL.md that actually backs it", async () => {
    const { manifest, repo } = await machine(INSTALLED);
    const verified = await verifyGrillSkill(repo, "grilling", manifest);

    expect(verified.id).toBe("pocock-plus:grilling");
    expect(verified.resolution.status).toBe("resolved");
    if (verified.resolution.status !== "resolved") return;
    expect(verified.resolution.source).toBe("pocock-plus");
    expect(verified.resolution.skill.name).toBe("grilling");
    expect(verified.resolution.skill.path).toEndWith(
      "skills/productivity/grilling/SKILL.md",
    );
  });

  /**
   * THE CASE `skills.test.ts` CANNOT REACH. Upstream renames `to-spec` to
   * `spec-it`; `GRILL_MODES.spec.skill` still equals its own literal and the
   * pinning test stays green, while the grill would route at a skill that is
   * no longer there.
   */
  test("an upstream rename is caught, not absorbed", async () => {
    const renamed = INSTALLED.filter(({ name }) => name !== "to-spec");
    const { manifest, repo } = await machine([
      ...renamed,
      { category: "engineering", name: "spec-it" },
    ]);

    const verified = await verifyGrillSkill(repo, "spec", manifest);

    expect(verified.resolution.status).toBe("missing");
    if (verified.resolution.status !== "missing") return;
    expect(verified.resolution.reason).toContain("declares no skill named 'to-spec'");
    // And the pinning test's own assertion still holds, which is the point.
    expect(GRILL_MODES.spec.skill).toBe("pocock-plus:to-spec");
  });

  test("a plugin that is not installed at all is named as such", async () => {
    const { manifest, repo } = await machine(INSTALLED, { qualifier: "someone-else" });
    const verified = await verifyGrillSkill(repo, "grilling", manifest);

    expect(verified.resolution.status).toBe("missing");
    if (verified.resolution.status !== "missing") return;
    expect(verified.resolution.reason).toContain("no active install of plugin");
  });

  /**
   * The distinction #89 actually turned up on this machine: present on disk,
   * reachable as a slash command, and NOT invocable by the model — which is
   * the only thing the grill dispatch prompt ever asks for.
   */
  test("a slash-only skill resolves but reports that a model cannot invoke it", async () => {
    const { manifest, repo } = await machine(
      INSTALLED.map((skill) =>
        skill.name === "to-spec" ? { ...skill, slashOnly: true } : skill,
      ),
    );

    const spec = await verifyGrillSkill(repo, "spec", manifest);
    const grilling = await verifyGrillSkill(repo, "grilling", manifest);

    expect(spec.resolution.status).toBe("resolved");
    if (spec.resolution.status !== "resolved") return;
    expect(spec.resolution.skill.modelInvocable).toBe(false);

    expect(grilling.resolution.status).toBe("resolved");
    if (grilling.resolution.status !== "resolved") return;
    expect(grilling.resolution.skill.modelInvocable).toBe(true);
  });

  /** SPEC §8.2: "The plugin id is the fallback, never the override." */
  test("the repo's canonical store outranks the installed plugin", async () => {
    const { manifest, repo } = await machine(INSTALLED);
    const canonical = join(repo, ".argus", "skills", "grilling");
    await mkdir(canonical, { recursive: true });
    await Bun.write(
      join(canonical, "SKILL.md"),
      "---\nname: grilling\ndescription: the repo's own copy\n---\n\nbody",
    );

    const verified = await verifyGrillSkill(repo, "grilling", manifest);

    expect(verified.id).toBe("grilling");
    expect(verified.resolution.status).toBe("resolved");
    if (verified.resolution.status !== "resolved") return;
    expect(verified.resolution.source).toBe("argus-canonical");
    expect(verified.resolution.skill.path).toBe(join(canonical, "SKILL.md"));
  });
});

describe("installedPluginSkills", () => {
  /**
   * The cache holds several versions side by side. Only the one
   * `installed_plugins.json` names is the one `claude` loads, so a resolver
   * that globbed the cache would answer "installed" for a version that can
   * never be reached.
   */
  test("reads only the version the manifest declares active", async () => {
    const { manifest, root } = await machine(INSTALLED, { version: "1.2.3-johan.7" });
    const stale = join(root, "cache", "pocock-plus", "1.2.3-johan.2", "skills");
    await mkdir(join(stale, "engineering", "retired-skill"), { recursive: true });
    await Bun.write(
      join(stale, "engineering", "retired-skill", "SKILL.md"),
      "---\nname: retired-skill\ndescription: only in the old version\n---\n\nbody",
    );

    const skills = await installedPluginSkills("pocock-plus", manifest);

    expect(skills).not.toBeNull();
    expect(skills?.has("grilling")).toBe(true);
    expect(skills?.has("retired-skill")).toBe(false);
  });

  test("a missing manifest is null, never an empty installed set", async () => {
    expect(await installedPluginSkills("pocock-plus", "/nope/absent.json")).toBeNull();
  });
});
