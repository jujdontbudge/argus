import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchMemoryPreamble } from "./preamble.ts";
import { dispatchSkillPreamble } from "./skill-match.ts";

describe("dispatch retrieval (#132, #133)", () => {
  test("retrieves memory verbatim with its MEMORY.md identity", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-preamble-"));
    try {
      await mkdir(join(repo, ".argus/memory"), { recursive: true });
      await Bun.write(join(repo, ".argus/memory/MEMORY.md"), "- [Metro](metro.md) — Metro port\n");
      await Bun.write(join(repo, ".argus/memory/metro.md"), "# Metro\nUse 8082.\n");
      const result = await dispatchMemoryPreamble(repo, "Metro port");
      expect(result).toContain("### - [Metro](metro.md) — Metro port");
      expect(result).toContain("# Metro\nUse 8082.\n");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  test("skill budget lists a complete omitted skill by name and path", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-skill-match-"));
    try {
      await mkdir(join(repo, ".argus/skills/one"), { recursive: true });
      await Bun.write(join(repo, ".argus/skills/one/SKILL.md"), "---\nname: one\ndescription: deploy tickets\n---\nwhole body\n");
      const result = await dispatchSkillPreamble(repo, "deploy", { maxSkills: 1, maxChars: 1 });
      expect(result).toContain("one: ");
      expect(result).toContain(".argus/skills/one/SKILL.md");
      expect(result).not.toContain("whole body");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
