/**
 * The Reviewer's four idempotent output surfaces (SPEC §5.1, §8):
 *
 * - USER.md — registry-verified JOHAN-AUTHORED findings only. The gate is the
 *   provenance record behind each cited source uuid, never the model's word:
 *   one non-Johan (or unknown, or missing) citation rejects the finding.
 * - MEMORY.md — durable project facts from ANY provenance, in the canonical
 *   index + per-fact-file format (SPEC §4). Fact files are the source of
 *   truth; the index converges to them (orphan repair).
 * - Skills — `.argus/skills/<slug>/SKILL.md`.
 * - Hermes §-entries — Hermes appends `\n§\n`-delimited entries to the shared
 *   files (#10 caveat); the fold converts them into the index format.
 *
 * Every writer is convergent: applying the same finding twice leaves every
 * file byte-identical.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Author } from "../../provenance";
import { normalizeSlug, type Finding } from "./schema";

export interface ApplyContext {
  /** `.argus/memory` — holds USER.md, MEMORY.md and the per-fact files. */
  memoryDir: string;
  /** `.argus/skills` — one `<slug>/SKILL.md` per procedure. */
  skillsDir: string;
  /** Registry-backed provenance lookup by transcript message uuid. */
  authorOf: (uuid: string) => Author | undefined;
}

export type RejectionReason =
  | "user-preference-not-johan-authored";

export interface Rejection {
  finding: Finding;
  reason: RejectionReason;
}

export interface ApplyResult {
  applied: {
    userPreferences: string[];
    facts: string[];
    skills: string[];
  };
  /** Loud, never silent: gated-out findings are reported, not dropped. */
  rejected: Rejection[];
}

const USER_HEADER = "# USER.md\n";
const MEMORY_HEADER = "# Memory index\n";
const HERMES_DELIMITER = /\r?\n§\r?\n/;

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

function hook(content: string): string {
  const first = oneLine(content.split(/\r?\n/, 1)[0] ?? "");
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

async function writeIfChanged(path: string, contents: string): Promise<void> {
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === contents) return;
  await Bun.write(path, contents);
}

/** Replace the slug-marked line if present, else append; convergent. */
async function upsertMarkedLine(
  path: string,
  header: string,
  slug: string,
  line: string,
): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : header;
  const marker = `<!-- argus:${slug} -->`;
  const lines = existing.split("\n");
  const at = lines.findIndex((candidate) => candidate.endsWith(marker));
  if (at >= 0) lines[at] = line;
  const next =
    at >= 0
      ? lines.join("\n")
      : `${existing.replace(/\n*$/, "\n")}${line}\n`;
  await writeIfChanged(path, next);
}

function userEntryLine(slug: string, content: string): string {
  return `- ${oneLine(content)} <!-- argus:${slug} -->`;
}

function factFileContents(slug: string, title: string, content: string): string {
  return [
    "---",
    `name: ${slug}`,
    `description: ${oneLine(title)}`,
    "metadata:",
    "  type: project",
    "---",
    "",
    content.replace(/\n*$/, ""),
    "",
  ].join("\n");
}

function factIndexLine(slug: string, title: string, content: string): string {
  return `- [${oneLine(title)}](${slug}.md) — ${hook(content)}`;
}

const INDEX_LINE = /^- \[(.+?)\]\((.+?\.md)\) — /;

/**
 * The fact file one index line points at, or null when the line is not an
 * index entry. Exported so every reader of MEMORY.md (the curator's scan and
 * its archive pass, #35) matches lines exactly the way this writer emits them.
 */
export function memoryIndexTarget(line: string): string | null {
  return INDEX_LINE.exec(line)?.[2] ?? null;
}

/** Replace the line indexing `<slug>.md` if present, else append. */
async function upsertIndexLine(
  memoryDir: string,
  slug: string,
  line: string,
): Promise<void> {
  const path = join(memoryDir, "MEMORY.md");
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : MEMORY_HEADER;
  const lines = existing.split("\n");
  const at = lines.findIndex(
    (candidate) => INDEX_LINE.exec(candidate)?.[2] === `${slug}.md`,
  );
  if (at >= 0) lines[at] = line;
  const next =
    at >= 0
      ? lines.join("\n")
      : `${existing.replace(/\n*$/, "\n")}${line}\n`;
  await writeIfChanged(path, next);
}

async function writeFact(
  memoryDir: string,
  slug: string,
  title: string,
  content: string,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await writeIfChanged(
    join(memoryDir, `${slug}.md`),
    factFileContents(slug, title, content),
  );
  await upsertIndexLine(memoryDir, slug, factIndexLine(slug, title, content));
}

async function writeSkill(
  skillsDir: string,
  slug: string,
  title: string,
  content: string,
): Promise<void> {
  const directory = join(skillsDir, slug);
  await mkdir(directory, { recursive: true });
  await writeIfChanged(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${slug}`,
      `description: ${oneLine(title)}`,
      "---",
      "",
      content.replace(/\n*$/, ""),
      "",
    ].join("\n"),
  );
}

/** Apply one verdict's findings to the three destinations, gated and convergent. */
export async function applyFindings(
  context: ApplyContext,
  findings: Finding[],
): Promise<ApplyResult> {
  const result: ApplyResult = {
    applied: { userPreferences: [], facts: [], skills: [] },
    rejected: [],
  };
  for (const finding of findings) {
    switch (finding.kind) {
      case "user-preference": {
        const johanAuthored =
          finding.sources.length > 0 &&
          finding.sources.every(
            (source) => context.authorOf(source) === "johan",
          );
        if (!johanAuthored) {
          result.rejected.push({
            finding,
            reason: "user-preference-not-johan-authored",
          });
          break;
        }
        await mkdir(context.memoryDir, { recursive: true });
        await upsertMarkedLine(
          join(context.memoryDir, "USER.md"),
          USER_HEADER,
          finding.slug,
          userEntryLine(finding.slug, finding.content),
        );
        result.applied.userPreferences.push(finding.slug);
        break;
      }
      case "project-fact": {
        await writeFact(
          context.memoryDir,
          finding.slug,
          finding.title,
          finding.content,
        );
        result.applied.facts.push(finding.slug);
        break;
      }
      case "procedure": {
        await writeSkill(
          context.skillsDir,
          finding.slug,
          finding.title,
          finding.content,
        );
        result.applied.skills.push(finding.slug);
        break;
      }
    }
  }
  return result;
}

function hermesEntryIdentity(entry: string): { slug: string; title: string } {
  const first = oneLine(entry.split(/\r?\n/, 1)[0] ?? "");
  const title = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return { slug: normalizeSlug(title), title };
}

/**
 * Fold Hermes' `\n§\n`-appended entries (#10 caveat) back into the canonical
 * formats: MEMORY.md entries become per-fact files + index lines, USER.md
 * entries become marked entry lines. A §-free file is left untouched.
 */
export async function foldHermesEntries(memoryDir: string): Promise<void> {
  const memoryPath = join(memoryDir, "MEMORY.md");
  const memoryFile = Bun.file(memoryPath);
  if (await memoryFile.exists()) {
    const [index = "", ...entries] = (await memoryFile.text()).split(
      HERMES_DELIMITER,
    );
    if (entries.length > 0) {
      await writeIfChanged(memoryPath, index.replace(/\n*$/, "\n"));
      for (const entry of entries) {
        const body = entry.trim();
        if (body.length === 0) continue;
        const { slug, title } = hermesEntryIdentity(body);
        if (slug.length === 0) continue;
        await writeFact(memoryDir, slug, title, body);
      }
    }
  }

  const userPath = join(memoryDir, "USER.md");
  const userFile = Bun.file(userPath);
  if (await userFile.exists()) {
    const [kept = "", ...entries] = (await userFile.text()).split(
      HERMES_DELIMITER,
    );
    if (entries.length > 0) {
      await writeIfChanged(userPath, kept.replace(/\n*$/, "\n"));
      for (const entry of entries) {
        const body = entry.trim();
        if (body.length === 0) continue;
        const { slug } = hermesEntryIdentity(body);
        if (slug.length === 0) continue;
        await upsertMarkedLine(
          userPath,
          USER_HEADER,
          slug,
          userEntryLine(slug, body),
        );
      }
    }
  }
}

interface FactFile {
  slug: string;
  title: string;
  body: string;
}

async function readFactFile(path: string, slug: string): Promise<FactFile | null> {
  const text = await Bun.file(path).text();
  const match = text.match(
    /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/,
  );
  if (!match) return null;
  const description = match[1]!
    .split("\n")
    .find((line) => line.startsWith("description: "));
  if (!description) return null;
  return {
    slug,
    title: description.slice("description: ".length),
    body: match[2]!,
  };
}

/**
 * Converge MEMORY.md to the fact files beside it (§5.1 orphan repair): a fact
 * file without an index line gets one; an index line whose file is gone is
 * dropped. Fact files are the store; the index is derived.
 */
export async function repairMemoryIndex(memoryDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(memoryDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const facts = new Map<string, FactFile>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === "MEMORY.md" || entry.name === "USER.md") continue;
    const slug = entry.name.slice(0, -".md".length);
    const fact = await readFactFile(join(memoryDir, entry.name), slug);
    if (fact) facts.set(`${slug}.md`, fact);
  }
  if (facts.size === 0 && !(await Bun.file(join(memoryDir, "MEMORY.md")).exists())) {
    return;
  }

  const path = join(memoryDir, "MEMORY.md");
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : MEMORY_HEADER;
  const indexed = new Set<string>();
  const kept: string[] = [];
  for (const line of existing.replace(/\n$/, "").split("\n")) {
    const target = INDEX_LINE.exec(line)?.[2];
    if (target === undefined) {
      kept.push(line);
      continue;
    }
    const fact = facts.get(target);
    if (!fact) continue; // orphan line: its file is gone
    indexed.add(target);
    kept.push(factIndexLine(fact.slug, fact.title, fact.body));
  }
  for (const [target, fact] of [...facts].sort(([a], [b]) => a.localeCompare(b))) {
    if (indexed.has(target)) continue;
    kept.push(factIndexLine(fact.slug, fact.title, fact.body));
  }
  await writeIfChanged(path, `${kept.join("\n")}\n`);
}
