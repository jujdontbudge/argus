/**
 * Dispatch-time skill retrieval (#133).
 *
 * Only complete SKILL.md files are inlineable. A size-excluded match is named
 * with its path, making the bounded decision visible rather than silent.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ranked } from "./matching.ts";
export interface SkillCaps { maxSkills: number; maxChars: number }
export const DEFAULT_SKILL_CAPS: SkillCaps = { maxSkills: 3, maxChars: 20_000 };
interface Skill { name: string; path: string; searchable: string; body: string }
function frontmatter(text: string): { name: string; description: string } {
  const head = text.match(/^---\s*\n([\s\S]*?)\n---/m)?.[1] ?? "";
  const read = (key: string) => head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  return { name: read("name"), description: read("description") };
}
export async function dispatchSkillPreamble(repo: string, query: string, caps: SkillCaps = DEFAULT_SKILL_CAPS): Promise<string> {
  const directory = join(repo, ".argus", "skills");
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return ""; }
  const skills: Skill[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name, "SKILL.md"); const file = Bun.file(path); if (!(await file.exists())) continue;
    const body = await file.text(); const meta = frontmatter(body);
    skills.push({ name: meta.name || entry.name, path, searchable: `${meta.name} ${meta.description}`, body });
  }
  const included: string[] = []; const omitted: string[] = []; let size = 0;
  for (const skill of ranked(query, skills).slice(0, caps.maxSkills)) {
    const block = `### ${skill.name} (${skill.path})\n${skill.body}`;
    if (size + block.length > caps.maxChars) { omitted.push(`- ${skill.name}: ${skill.path}`); continue; }
    included.push(block); size += block.length;
  }
  if (included.length === 0 && omitted.length === 0) return "";
  return ["\n\nMATCHED CODEX SKILLS (verbatim):", ...included, ...(omitted.length ? ["\nSkills omitted by the size budget:", ...omitted] : [])].join("\n\n");
}
