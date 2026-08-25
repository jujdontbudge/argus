import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Author } from "../../provenance";
import {
  applyFindings,
  foldHermesEntries,
  repairMemoryIndex,
  type ApplyContext,
} from "./outputs";
import type { Finding } from "./schema";

interface World {
  memoryDir: string;
  skillsDir: string;
  context: (authors?: Record<string, Author>) => ApplyContext;
  read: (relativePath: string) => Promise<string>;
  exists: (relativePath: string) => Promise<boolean>;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-reviewer-outputs-"));
  const memoryDir = join(root, "memory");
  const skillsDir = join(root, "skills");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  try {
    await body({
      memoryDir,
      skillsDir,
      context: (authors = {}) => ({
        memoryDir,
        skillsDir,
        authorOf: (uuid) => authors[uuid],
      }),
      read: (relativePath) => Bun.file(join(root, relativePath)).text(),
      exists: (relativePath) => Bun.file(join(root, relativePath)).exists(),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const FACT: Finding = {
  kind: "project-fact",
  slug: "metro-port",
  title: "Metro port",
  content: "Metro runs on 8082, not the default 8081.",
  sources: ["uuid-agent"],
};

const PREFERENCE: Finding = {
  kind: "user-preference",
  slug: "prefers-tabs",
  title: "Prefers tabs",
  content: "Johan prefers tabs over spaces.",
  sources: ["uuid-johan"],
};

const PROCEDURE: Finding = {
  kind: "procedure",
  slug: "release-hotfix",
  title: "Release a hotfix",
  content: "1. Branch from main\n2. Fix\n3. Tag",
  sources: [],
};

describe("MEMORY.md facts (any provenance; index + per-fact files)", () => {
  test("a project fact writes a per-fact file AND its index line; reapply is byte-identical", async () => {
    await withWorld(async (world) => {
      const result = await applyFindings(
        world.context({ "uuid-agent": "agent" }),
        [FACT],
      );
      expect(result.applied.facts).toEqual(["metro-port"]);

      const factFile = await world.read("memory/metro-port.md");
      expect(factFile).toContain("name: metro-port");
      expect(factFile).toContain("type: project");
      expect(factFile).toContain("Metro runs on 8082");
      const index = await world.read("memory/MEMORY.md");
      expect(index).toContain("- [Metro port](metro-port.md) — ");

      await applyFindings(world.context({ "uuid-agent": "agent" }), [FACT]);
      expect(await world.read("memory/metro-port.md")).toBe(factFile);
      expect(await world.read("memory/MEMORY.md")).toBe(index);
    });
  });

  test("facts are accepted from ANY provenance, even with no cited sources", async () => {
    await withWorld(async (world) => {
      const result = await applyFindings(world.context(), [
        { ...FACT, sources: [] },
      ]);
      expect(result.applied.facts).toEqual(["metro-port"]);
      expect(result.rejected).toEqual([]);
    });
  });

  test("a repeat fact with new content updates the file and its index line in place", async () => {
    await withWorld(async (world) => {
      await applyFindings(world.context(), [FACT]);
      await applyFindings(world.context(), [
        { ...FACT, content: "Metro moved to 8083." },
      ]);
      expect(await world.read("memory/metro-port.md")).toContain("8083");
      const index = await world.read("memory/MEMORY.md");
      expect(index.match(/metro-port\.md/g)?.length).toBe(1);
      expect(index).toContain("Metro moved to 8083.");
    });
  });
});

describe("USER.md (registry-verified Johan-authored ONLY — the provenance gate)", () => {
  test("a preference whose every source is Johan-authored lands in USER.md; reapply is byte-identical", async () => {
    await withWorld(async (world) => {
      const result = await applyFindings(
        world.context({ "uuid-johan": "johan" }),
        [PREFERENCE],
      );
      expect(result.applied.userPreferences).toEqual(["prefers-tabs"]);
      const user = await world.read("memory/USER.md");
      expect(user).toContain("Johan prefers tabs over spaces.");

      await applyFindings(world.context({ "uuid-johan": "johan" }), [PREFERENCE]);
      expect(await world.read("memory/USER.md")).toBe(user);
    });
  });

  test("a preference citing a Hermes-authored message is REJECTED and USER.md is not created", async () => {
    await withWorld(async (world) => {
      const result = await applyFindings(
        world.context({ "uuid-johan": "johan", "uuid-hermes": "hermes" }),
        [{ ...PREFERENCE, sources: ["uuid-johan", "uuid-hermes"] }],
      );
      expect(result.applied.userPreferences).toEqual([]);
      expect(result.rejected.length).toBe(1);
      expect(result.rejected[0]!.reason).toBe("user-preference-not-johan-authored");
      expect(await world.exists("memory/USER.md")).toBe(false);
    });
  });

  test("agent-authored, unknown and uncited sources are all rejected — the model's word is never the gate", async () => {
    await withWorld(async (world) => {
      const result = await applyFindings(
        world.context({ "uuid-agent": "agent" }),
        [
          { ...PREFERENCE, slug: "a", sources: ["uuid-agent"] },
          { ...PREFERENCE, slug: "b", sources: ["uuid-never-seen"] },
          { ...PREFERENCE, slug: "c", sources: [] },
        ],
      );
      expect(result.applied.userPreferences).toEqual([]);
      expect(result.rejected.length).toBe(3);
      expect(await world.exists("memory/USER.md")).toBe(false);
    });
  });

  test("a repeat preference with new content replaces its entry instead of duplicating", async () => {
    await withWorld(async (world) => {
      const authors: Record<string, Author> = { "uuid-johan": "johan" };
      await applyFindings(world.context(authors), [PREFERENCE]);
      await applyFindings(world.context(authors), [
        { ...PREFERENCE, content: "Johan now prefers spaces, two of them." },
      ]);
      const user = await world.read("memory/USER.md");
      expect(user).toContain("two of them");
      expect(user).not.toContain("tabs over spaces");
    });
  });
});

describe("skills (.argus/skills/<slug>/SKILL.md)", () => {
  test("a procedure writes SKILL.md with frontmatter; reapply byte-identical; update rewrites", async () => {
    await withWorld(async (world) => {
      const result = await applyFindings(world.context(), [PROCEDURE]);
      expect(result.applied.skills).toEqual(["release-hotfix"]);
      const skill = await world.read("skills/release-hotfix/SKILL.md");
      expect(skill).toContain("name: release-hotfix");
      expect(skill).toContain("description: Release a hotfix");
      expect(skill).toContain("2. Fix");

      await applyFindings(world.context(), [PROCEDURE]);
      expect(await world.read("skills/release-hotfix/SKILL.md")).toBe(skill);

      await applyFindings(world.context(), [
        { ...PROCEDURE, content: "1. Branch\n2. Fix\n3. Tag\n4. Notify" },
      ]);
      expect(await world.read("skills/release-hotfix/SKILL.md")).toContain("4. Notify");
    });
  });
});

describe("folding Hermes §-entries into the index format (#10 caveat)", () => {
  test("MEMORY.md § entries become per-fact files + index lines; the fold converges", async () => {
    await withWorld(async (world) => {
      await applyFindings(world.context(), [FACT]);
      const before = await world.read("memory/MEMORY.md");
      await Bun.write(
        join(world.memoryDir, "MEMORY.md"),
        `${before}\n§\nDeploy needs the VPN up first\n§\nThe staging DB resets nightly at 03:00`,
      );

      await foldHermesEntries(world.memoryDir);

      const folded = await world.read("memory/MEMORY.md");
      expect(folded).not.toContain("§");
      expect(folded).toContain("- [Metro port](metro-port.md) — ");
      expect(folded).toContain("(deploy-needs-the-vpn-up-first.md)");
      expect(
        await world.read("memory/deploy-needs-the-vpn-up-first.md"),
      ).toContain("Deploy needs the VPN up first");
      expect(
        await world.read("memory/the-staging-db-resets-nightly-at-03-00.md"),
      ).toContain("resets nightly");

      await foldHermesEntries(world.memoryDir);
      expect(await world.read("memory/MEMORY.md")).toBe(folded);
    });
  });

  test("USER.md § entries fold into entry lines, content preserved", async () => {
    await withWorld(async (world) => {
      await applyFindings(world.context({ "uuid-johan": "johan" }), [PREFERENCE]);
      const before = await world.read("memory/USER.md");
      await Bun.write(
        join(world.memoryDir, "USER.md"),
        `${before}\n§\nGets annoyed by long preambles in answers`,
      );

      await foldHermesEntries(world.memoryDir);

      const folded = await world.read("memory/USER.md");
      expect(folded).not.toContain("§");
      expect(folded).toContain("Johan prefers tabs over spaces.");
      expect(folded).toContain("Gets annoyed by long preambles in answers");

      await foldHermesEntries(world.memoryDir);
      expect(await world.read("memory/USER.md")).toBe(folded);
    });
  });

  test("folding with no memory files at all is a quiet no-op", async () => {
    await withWorld(async (world) => {
      await foldHermesEntries(world.memoryDir);
      expect(await world.exists("memory/MEMORY.md")).toBe(false);
    });
  });
});

describe("orphan repair (fact files are truth; the index converges)", () => {
  test("a fact file without an index line gets its line appended", async () => {
    await withWorld(async (world) => {
      await applyFindings(world.context(), [FACT]);
      await rm(join(world.memoryDir, "MEMORY.md"));

      await repairMemoryIndex(world.memoryDir);

      const index = await world.read("memory/MEMORY.md");
      expect(index).toContain("- [Metro port](metro-port.md) — ");
    });
  });

  test("an index line whose fact file is gone is dropped", async () => {
    await withWorld(async (world) => {
      await applyFindings(world.context(), [FACT, { ...FACT, slug: "other-fact", title: "Other" }]);
      await rm(join(world.memoryDir, "other-fact.md"));

      await repairMemoryIndex(world.memoryDir);

      const index = await world.read("memory/MEMORY.md");
      expect(index).toContain("metro-port.md");
      expect(index).not.toContain("other-fact.md");
    });
  });

  test("a converged index is byte-stable under repair", async () => {
    await withWorld(async (world) => {
      await applyFindings(world.context(), [FACT]);
      const before = await world.read("memory/MEMORY.md");
      await repairMemoryIndex(world.memoryDir);
      expect(await world.read("memory/MEMORY.md")).toBe(before);
    });
  });
});
