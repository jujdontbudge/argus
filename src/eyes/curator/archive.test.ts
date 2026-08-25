import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFact, archiveSkill, restoreSkill } from "./archive";
import { emptyRecord, latestActivityAt, readUsage, updateUsage } from "./usage";

const AT = "2026-08-24T12:00:00.000Z";
const LATER = "2026-09-01T09:30:00.000Z";

async function withRepo(
  body: (paths: { skillsDir: string; memoryDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-curator-archive-"));
  try {
    await body({
      skillsDir: join(root, ".argus/skills"),
      memoryDir: join(root, ".argus/memory"),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function plantSkill(
  skillsDir: string,
  relative: string,
  name: string,
): Promise<string> {
  const dir = join(skillsDir, relative);
  await mkdir(join(dir, "references"), { recursive: true });
  await Bun.write(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\nbody\n`);
  await Bun.write(join(dir, "references/notes.md"), "support file\n");
  await updateUsage(skillsDir, (sidecar) => {
    sidecar[name] = emptyRecord(AT);
  });
  return dir;
}

const exists = (path: string): Promise<boolean> => Bun.file(path).exists();

describe("archive semantics (lifted: tools/skill_usage.py:672-725) — never delete", () => {
  test("the whole package moves under .archive/<name>/, support files included", async () => {
    await withRepo(async ({ skillsDir }) => {
      const dir = await plantSkill(skillsDir, "deploy-dance", "deploy-dance");

      const archived = await archiveSkill({
        skillsDir,
        dir,
        name: "deploy-dance",
        at: AT,
        reason: "90 days idle",
      });

      expect(await exists(join(dir, "SKILL.md"))).toBe(false);
      expect(archived.to).toBe(join(skillsDir, ".archive/deploy-dance"));
      expect(await exists(join(archived.to, "SKILL.md"))).toBe(true);
      expect(await exists(join(archived.to, "references/notes.md"))).toBe(true);

      const record = (await readUsage(skillsDir))["deploy-dance"]!;
      expect(record.state).toBe("archived");
      expect(record.archived_at).toBe(AT);
    });
  });

  test("a category-nested skill is flattened into the archive", async () => {
    await withRepo(async ({ skillsDir }) => {
      const dir = await plantSkill(skillsDir, "deploy/staging-cert", "staging-cert");
      const archived = await archiveSkill({
        skillsDir,
        dir,
        name: "staging-cert",
        at: AT,
        reason: "idle",
      });
      expect(archived.to).toBe(join(skillsDir, ".archive/staging-cert"));
      expect(await exists(join(archived.to, "SKILL.md"))).toBe(true);
    });
  });

  test("a name collision is timestamp-suffixed — an earlier archive is never overwritten", async () => {
    await withRepo(async ({ skillsDir }) => {
      const first = await plantSkill(skillsDir, "twice", "twice");
      await Bun.write(join(first, "SKILL.md"), "---\nname: twice\n---\n\nfirst\n");
      await archiveSkill({ skillsDir, dir: first, name: "twice", at: AT, reason: "idle" });

      const second = await plantSkill(skillsDir, "twice", "twice");
      await Bun.write(join(second, "SKILL.md"), "---\nname: twice\n---\n\nsecond\n");
      const archived = await archiveSkill({
        skillsDir,
        dir: second,
        name: "twice",
        at: LATER,
        reason: "idle",
      });

      expect(archived.to).toBe(join(skillsDir, ".archive/twice-20260901T093000Z"));
      expect(await Bun.file(join(skillsDir, ".archive/twice/SKILL.md")).text()).toContain(
        "first",
      );
      expect(await Bun.file(join(archived.to, "SKILL.md")).text()).toContain("second");
    });
  });

  test("a consolidation records the umbrella that absorbed the skill", async () => {
    await withRepo(async ({ skillsDir }) => {
      const dir = await plantSkill(skillsDir, "narrow-sibling", "narrow-sibling");
      await archiveSkill({
        skillsDir,
        dir,
        name: "narrow-sibling",
        at: AT,
        reason: "folded in",
        absorbedInto: "umbrella",
      });
      expect((await readUsage(skillsDir))["narrow-sibling"]!.absorbed_into).toBe("umbrella");
    });
  });

  test("restore moves the package back and resets the clock so it is not re-archived", async () => {
    await withRepo(async ({ skillsDir }) => {
      const dir = await plantSkill(skillsDir, "wrongly-pruned", "wrongly-pruned");
      await archiveSkill({ skillsDir, dir, name: "wrongly-pruned", at: AT, reason: "idle" });

      const restored = await restoreSkill(skillsDir, "wrongly-pruned", { at: LATER });

      expect(restored.to).toBe(join(skillsDir, "wrongly-pruned"));
      expect(await exists(join(restored.to, "SKILL.md"))).toBe(true);
      expect(await readdir(join(skillsDir, ".archive"))).toEqual([]);
      const record = (await readUsage(skillsDir))["wrongly-pruned"]!;
      expect(record.state).toBe("active");
      expect(record.archived_at).toBeNull();
      expect(latestActivityAt(record)).toBe(LATER);
    });
  });
});

describe("the memory archive mirror (.argus/memory/.archive/)", () => {
  test("the fact file moves and its index line goes, leaving the rest of the index", async () => {
    await withRepo(async ({ memoryDir }) => {
      await mkdir(memoryDir, { recursive: true });
      await Bun.write(join(memoryDir, "metro-port.md"), "---\nname: metro-port\n---\n\n8082\n");
      await Bun.write(
        join(memoryDir, "MEMORY.md"),
        [
          "# Memory index",
          "",
          "- [Metro port](metro-port.md) — 8082",
          "- [Kept fact](kept.md) — still true",
          "",
        ].join("\n"),
      );

      const archived = await archiveFact(memoryDir, "metro-port", { at: AT });

      expect(archived.to).toBe(join(memoryDir, ".archive/metro-port.md"));
      expect(await exists(join(memoryDir, "metro-port.md"))).toBe(false);
      expect(await Bun.file(archived.to).text()).toContain("8082");
      const index = await Bun.file(join(memoryDir, "MEMORY.md")).text();
      expect(index).not.toContain("metro-port.md");
      expect(index).toContain("- [Kept fact](kept.md) — still true");
    });
  });

  test("a fact file with no index line still archives (the orphan-file case)", async () => {
    await withRepo(async ({ memoryDir }) => {
      await mkdir(memoryDir, { recursive: true });
      await Bun.write(join(memoryDir, "orphan.md"), "---\nname: orphan\n---\n\nlost\n");
      const archived = await archiveFact(memoryDir, "orphan", { at: AT });
      expect(await exists(archived.to)).toBe(true);
      expect(await exists(join(memoryDir, "orphan.md"))).toBe(false);
    });
  });
});
