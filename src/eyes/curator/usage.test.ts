import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyRecord,
  latestActivityAt,
  readUsage,
  recordSkillWrites,
  updateUsage,
  usagePath,
} from "./usage";

async function withSkills(body: (skillsDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-curator-usage-"));
  try {
    await body(join(root, "skills"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const AT = "2026-08-24T12:00:00.000Z";
const LATER = "2026-08-25T12:00:00.000Z";

describe("the .usage.json sidecar (lifted from Hermes tools/skill_usage.py)", () => {
  test("a missing sidecar reads as no records, not an error", async () => {
    await withSkills(async (skillsDir) => {
      expect(await readUsage(skillsDir)).toEqual({});
    });
  });

  test("updateUsage round-trips records through the sidecar file", async () => {
    await withSkills(async (skillsDir) => {
      await updateUsage(skillsDir, (sidecar) => {
        sidecar["deploy-dance"] = emptyRecord(AT);
      });

      expect(await readUsage(skillsDir)).toEqual({ "deploy-dance": emptyRecord(AT) });
      const raw = await Bun.file(usagePath(skillsDir)).json();
      expect(Object.keys(raw)).toEqual(["skills"]);
    });
  });

  test("a corrupt sidecar reads as empty — a torn file never kills the eye", async () => {
    await withSkills(async (skillsDir) => {
      await Bun.write(usagePath(skillsDir), "{not json");
      expect(await readUsage(skillsDir)).toEqual({});
    });
  });

  test("latestActivityAt is the newest of use/view/patch, null when never touched", () => {
    const never = emptyRecord(AT);
    expect(latestActivityAt(never)).toBeNull();
    expect(
      latestActivityAt({
        ...never,
        last_used_at: "2026-01-01T00:00:00.000Z",
        last_viewed_at: "2026-06-01T00:00:00.000Z",
        last_patched_at: "2026-03-01T00:00:00.000Z",
      }),
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  test("a first skill write seeds the record; a second bumps the patch clock", async () => {
    await withSkills(async (skillsDir) => {
      await recordSkillWrites(skillsDir, ["rotate-cert"], { at: AT, createdBy: "agent" });
      const seeded = (await readUsage(skillsDir))["rotate-cert"]!;
      expect(seeded.created_at).toBe(AT);
      expect(seeded.created_by).toBe("agent");
      expect(seeded.patch_count).toBe(0);
      expect(seeded.last_patched_at).toBe(AT);
      expect(seeded.pinned).toBe(false);
      expect(seeded.state).toBe("active");

      await recordSkillWrites(skillsDir, ["rotate-cert"], { at: LATER, createdBy: "agent" });
      const bumped = (await readUsage(skillsDir))["rotate-cert"]!;
      expect(bumped.created_at).toBe(AT);
      expect(bumped.patch_count).toBe(1);
      expect(bumped.last_patched_at).toBe(LATER);
    });
  });

  test("Johan-authored skills are pinned on creation (research #16 §7 provenance)", async () => {
    await withSkills(async (skillsDir) => {
      await recordSkillWrites(skillsDir, ["johans-ritual"], { at: AT, createdBy: "johan" });
      const record = (await readUsage(skillsDir))["johans-ritual"]!;
      expect(record.created_by).toBe("johan");
      expect(record.pinned).toBe(true);
    });
  });

  test("an agent rewrite never un-pins a Johan-authored skill", async () => {
    await withSkills(async (skillsDir) => {
      await recordSkillWrites(skillsDir, ["johans-ritual"], { at: AT, createdBy: "johan" });
      await recordSkillWrites(skillsDir, ["johans-ritual"], { at: LATER, createdBy: "agent" });
      const record = (await readUsage(skillsDir))["johans-ritual"]!;
      expect(record.created_by).toBe("johan");
      expect(record.pinned).toBe(true);
    });
  });

  test("concurrent updates serialize through the lock — neither write is lost", async () => {
    await withSkills(async (skillsDir) => {
      await Promise.all([
        updateUsage(skillsDir, (sidecar) => {
          sidecar.first = emptyRecord(AT);
        }),
        updateUsage(skillsDir, (sidecar) => {
          sidecar.second = emptyRecord(AT);
        }),
      ]);
      expect(Object.keys(await readUsage(skillsDir)).sort()).toEqual(["first", "second"]);
    });
  });
});
