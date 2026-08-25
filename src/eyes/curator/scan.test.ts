import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMemory, scanSkills } from "./scan";

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-curator-scan-"));
  try {
    await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const names = (scanned: { name: string }[]): string[] =>
  scanned.map(({ name }) => name).sort();

describe("the skills scan (re-specced: .argus/skills/**/SKILL.md)", () => {
  test("a package is identified by its frontmatter name, not its directory", async () => {
    await withDir(async (skillsDir) => {
      await mkdir(join(skillsDir, "some-dir"), { recursive: true });
      await Bun.write(
        join(skillsDir, "some-dir/SKILL.md"),
        "---\nname: rotate-staging-cert\ndescription: rotate it\n---\n\nbody\n",
      );
      const [candidate] = await scanSkills(skillsDir);
      expect(candidate!.name).toBe("rotate-staging-cert");
      expect(candidate!.dir).toBe(join(skillsDir, "some-dir"));
      expect(candidate!.relative).toBe("some-dir");
    });
  });

  test("a package with no frontmatter name falls back to its directory name", async () => {
    await withDir(async (skillsDir) => {
      await mkdir(join(skillsDir, "nameless"), { recursive: true });
      await Bun.write(join(skillsDir, "nameless/SKILL.md"), "no frontmatter here\n");
      expect(names(await scanSkills(skillsDir))).toEqual(["nameless"]);
    });
  });

  test("category nesting is walked, and support files ride with the package", async () => {
    await withDir(async (skillsDir) => {
      await mkdir(join(skillsDir, "deploy/staging-cert/references"), { recursive: true });
      await Bun.write(
        join(skillsDir, "deploy/staging-cert/SKILL.md"),
        "---\nname: staging-cert\n---\n\nbody\n",
      );
      await Bun.write(
        join(skillsDir, "deploy/staging-cert/references/vault.md"),
        "notes\n",
      );
      const [candidate] = await scanSkills(skillsDir);
      expect(candidate!.name).toBe("staging-cert");
      expect(candidate!.relative).toBe("deploy/staging-cert");
      expect(candidate!.supportFiles).toEqual(["references/vault.md"]);
    });
  });

  test("the scan never descends INTO a package — a nested SKILL.md is a support file", async () => {
    await withDir(async (skillsDir) => {
      await mkdir(join(skillsDir, "umbrella/references"), { recursive: true });
      await Bun.write(join(skillsDir, "umbrella/SKILL.md"), "---\nname: umbrella\n---\n\nb\n");
      await Bun.write(
        join(skillsDir, "umbrella/references/SKILL.md"),
        "---\nname: absorbed\n---\n\nb\n",
      );
      expect(names(await scanSkills(skillsDir))).toEqual(["umbrella"]);
    });
  });

  test("the archive and the usual junk dirs are invisible to the scan", async () => {
    await withDir(async (skillsDir) => {
      for (const excluded of [".archive/old", ".git/hooks", "node_modules/pkg", "__pycache__"]) {
        await mkdir(join(skillsDir, excluded), { recursive: true });
        await Bun.write(
          join(skillsDir, excluded, "SKILL.md"),
          `---\nname: ${excluded.replace(/\W/g, "-")}\n---\n\nb\n`,
        );
      }
      await mkdir(join(skillsDir, "live"), { recursive: true });
      await Bun.write(join(skillsDir, "live/SKILL.md"), "---\nname: live\n---\n\nb\n");
      expect(names(await scanSkills(skillsDir))).toEqual(["live"]);
    });
  });

  test("a repo with no skills dir scans as empty, not an error", async () => {
    await withDir(async (root) => {
      expect(await scanSkills(join(root, "absent"))).toEqual([]);
    });
  });
});

describe("the memory scan (re-specced: the MEMORY.md index + per-fact files)", () => {
  const seed = async (memoryDir: string): Promise<void> => {
    await mkdir(memoryDir, { recursive: true });
    await Bun.write(
      join(memoryDir, "metro-port.md"),
      "---\nname: metro-port\ndescription: Metro port\n---\n\nMetro runs on 8082.\n",
    );
    await Bun.write(
      join(memoryDir, "MEMORY.md"),
      "# Memory index\n\n- [Metro port](metro-port.md) — Metro runs on 8082.\n",
    );
    await Bun.write(join(memoryDir, "USER.md"), "# USER.md\n\n- Johan exists\n");
  };

  test("facts carry their description, their index state and their touch time", async () => {
    await withDir(async (memoryDir) => {
      await seed(memoryDir);
      const touched = new Date("2026-06-01T00:00:00.000Z");
      await utimes(join(memoryDir, "metro-port.md"), touched, touched);

      const scan = await scanMemory(memoryDir);
      expect(scan.facts.map(({ slug }) => slug)).toEqual(["metro-port"]);
      expect(scan.facts[0]!.title).toBe("Metro port");
      expect(scan.facts[0]!.indexed).toBe(true);
      expect(new Date(scan.facts[0]!.touchedAt).toISOString()).toBe(
        touched.toISOString(),
      );
      expect(scan.orphans).toEqual([]);
    });
  });

  test("an index line whose fact file is gone is flagged as an orphan", async () => {
    await withDir(async (memoryDir) => {
      await seed(memoryDir);
      await Bun.write(
        join(memoryDir, "MEMORY.md"),
        "# Memory index\n\n- [Metro port](metro-port.md) — 8082\n- [Ghost](ghost.md) — gone\n",
      );
      const scan = await scanMemory(memoryDir);
      expect(scan.orphans).toEqual([
        { kind: "index-without-file", slug: "ghost" },
      ]);
    });
  });

  test("a fact file nothing indexes is flagged as an orphan the other way", async () => {
    await withDir(async (memoryDir) => {
      await seed(memoryDir);
      await Bun.write(
        join(memoryDir, "unlisted.md"),
        "---\nname: unlisted\ndescription: Unlisted\n---\n\nbody\n",
      );
      const scan = await scanMemory(memoryDir);
      expect(scan.orphans).toEqual([
        { kind: "file-without-index", slug: "unlisted" },
      ]);
      expect(scan.facts.find(({ slug }) => slug === "unlisted")!.indexed).toBe(false);
    });
  });

  test("MEMORY.md, USER.md and the archive are not facts", async () => {
    await withDir(async (memoryDir) => {
      await seed(memoryDir);
      await mkdir(join(memoryDir, ".archive"), { recursive: true });
      await Bun.write(join(memoryDir, ".archive/retired.md"), "---\nname: retired\n---\n\nx\n");
      const scan = await scanMemory(memoryDir);
      expect(scan.facts.map(({ slug }) => slug)).toEqual(["metro-port"]);
    });
  });

  test("a repo with no memory dir scans as empty, not an error", async () => {
    await withDir(async (root) => {
      expect(await scanMemory(join(root, "absent"))).toEqual({ facts: [], orphans: [] });
    });
  });
});
