/**
 * What the curator looks at — RE-SPECCED (research #16 §8(i)).
 *
 * Hermes' enumeration is `rglob("SKILL.md")` under its own home and cannot be
 * pointed at a repo, so Argus specifies its own: walk
 * `.argus/skills/**\/SKILL.md`, skipping the archive and the usual junk dirs
 * (`agent/skill_utils.py:27-44`), identify a package by its frontmatter
 * `name:` with the directory name as fallback, and never descend INTO a
 * package — a SKILL.md under `references/` is support material, not a sibling.
 *
 * The second half has no native counterpart at all (the native curator is
 * skills-only): the MEMORY.md index and the per-fact files beside it. Fact
 * files are the store and the index is derived, so the scan reports both
 * directions of drift — an index line whose file is gone, and a fact file
 * nothing indexes.
 *
 * Staleness anchor for a fact: the file's mtime, i.e. the last Reviewer
 * touch. The #16 note also suggested git commit dates, but `.argus/` is
 * gitignored in every target repo (SPEC §4), so there is no git history to
 * anchor on — mtime is the only honest signal.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { memoryIndexTarget } from "../reviewer/outputs";
import { ARCHIVE_DIR } from "./archive";

/** `agent/skill_utils.py:27-44`, plus the JS-world equivalents. */
export const EXCLUDED_SKILL_DIRS: ReadonlySet<string> = new Set([
  ARCHIVE_DIR,
  ".git",
  ".hub",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".cache",
  ".pytest_cache",
]);

export interface SkillCandidate {
  /** Sidecar identity: frontmatter `name:`, directory name as fallback. */
  name: string;
  /** Absolute package directory. */
  dir: string;
  /** Package directory relative to the skills root (category nesting kept). */
  relative: string;
  /** Everything in the package besides SKILL.md, for package integrity. */
  supportFiles: string[];
  description: string;
}

function frontmatterField(text: string, field: string): string | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const found = line.match(new RegExp(`^${field}:\\s*(.*)$`));
    if (found) return found[1]!.trim();
  }
  return null;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(directory, entry.name), relative)));
      continue;
    }
    if (relative !== "SKILL.md") files.push(relative);
  }
  return files;
}

async function walkSkills(
  root: string,
  directory: string,
  relative: string,
  found: SkillCandidate[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // no skills dir yet, or unreadable: nothing to curate
  }
  const manifest = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
  if (manifest && relative.length > 0) {
    const text = await Bun.file(join(directory, "SKILL.md")).text();
    const name = frontmatterField(text, "name");
    found.push({
      name: name && name.length > 0 ? name : relative.split("/").at(-1)!,
      dir: directory,
      relative,
      supportFiles: await listFiles(directory),
      description: frontmatterField(text, "description") ?? "",
    });
    return; // a package is a leaf: never descend into it
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || EXCLUDED_SKILL_DIRS.has(entry.name)) continue;
    await walkSkills(
      root,
      join(directory, entry.name),
      relative.length > 0 ? `${relative}/${entry.name}` : entry.name,
      found,
    );
  }
}

export async function scanSkills(skillsDir: string): Promise<SkillCandidate[]> {
  const found: SkillCandidate[] = [];
  await walkSkills(skillsDir, skillsDir, "", found);
  return found;
}

export interface FactCandidate {
  slug: string;
  path: string;
  /** The fact file's `description:` — what the index line shows. */
  title: string;
  indexed: boolean;
  /** Epoch ms of the last Reviewer touch (mtime): the staleness anchor. */
  touchedAt: number;
}

export interface MemoryOrphan {
  kind: "index-without-file" | "file-without-index";
  slug: string;
}

export interface MemoryScan {
  facts: FactCandidate[];
  orphans: MemoryOrphan[];
}

const NOT_A_FACT: ReadonlySet<string> = new Set(["MEMORY.md", "USER.md"]);

export async function scanMemory(memoryDir: string): Promise<MemoryScan> {
  let entries;
  try {
    entries = await readdir(memoryDir, { withFileTypes: true });
  } catch {
    return { facts: [], orphans: [] };
  }

  const indexed = new Set<string>();
  const indexFile = Bun.file(join(memoryDir, "MEMORY.md"));
  if (await indexFile.exists()) {
    for (const line of (await indexFile.text()).split(/\r?\n/)) {
      const target = memoryIndexTarget(line);
      if (target) indexed.add(target);
    }
  }

  const facts: FactCandidate[] = [];
  const orphans: MemoryOrphan[] = [];
  const present = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (NOT_A_FACT.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(memoryDir, entry.name);
    const slug = entry.name.slice(0, -".md".length);
    present.add(entry.name);
    const isIndexed = indexed.has(entry.name);
    if (!isIndexed) orphans.push({ kind: "file-without-index", slug });
    const text = await Bun.file(path).text();
    facts.push({
      slug,
      path,
      title: frontmatterField(text, "description") ?? slug,
      indexed: isIndexed,
      touchedAt: (await stat(path)).mtimeMs,
    });
  }
  for (const target of [...indexed].sort()) {
    if (present.has(target)) continue;
    orphans.push({
      kind: "index-without-file",
      slug: target.slice(0, -".md".length),
    });
  }
  return { facts, orphans };
}
