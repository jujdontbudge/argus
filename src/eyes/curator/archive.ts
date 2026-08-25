/**
 * Archive semantics — the curator's maximum destructive action.
 *
 * LIFTED wholesale (research #16 §8(iii)) from Hermes `archive_skill`
 * (`tools/skill_usage.py:672-725`): the skill's WHOLE directory moves to
 * `.archive/<name>/`, flattened out of any category nesting and
 * timestamp-suffixed on collision, and the sidecar record is marked
 * `archived`. Nothing is ever deleted — "archive is recoverable" is the
 * invariant (`agent/curator.py:16-17`), so `restoreSkill` is the exact
 * inverse and resets the activity clock (a restored skill the curator
 * immediately re-archived would make restore a lie).
 *
 * NEW (the memory mirror, re-specced because the native curator is
 * skills-only): a curated-out fact moves to `.argus/memory/.archive/<slug>.md`
 * and loses its `MEMORY.md` index line. The fact files are the store and the
 * index is derived (§5.1 orphan repair), so removing the line last keeps the
 * two consistent at every instant.
 */
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { memoryIndexTarget } from "../reviewer/outputs";
import { updateUsage, type LockOptions } from "./usage";

/** Excluded from every scan; the one place archived packages live. */
export const ARCHIVE_DIR = ".archive";

export function skillsArchiveDir(skillsDir: string): string {
  return join(skillsDir, ARCHIVE_DIR);
}

export function memoryArchiveDir(memoryDir: string): string {
  return join(memoryDir, ARCHIVE_DIR);
}

/** `2026-09-01T09:30:00.000Z` → `20260901T093000Z`, the collision suffix. */
export function archiveStamp(at: string): string {
  return `${at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    // Cross-device (the archive on another filesystem): copy then drop the
    // source, the same fallback shutil.move makes.
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) {
      throw error;
    }
    await cp(from, to, { recursive: true });
    await rm(from, { force: true, recursive: true });
  }
}

async function freeDestination(
  directory: string,
  base: string,
  extension: string,
  at: string,
): Promise<string> {
  const plain = join(directory, `${base}${extension}`);
  if (!(await Bun.file(plain).exists()) && !(await directoryExists(plain))) {
    return plain;
  }
  return join(directory, `${base}-${archiveStamp(at)}${extension}`);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export interface ArchiveSkillOptions {
  skillsDir: string;
  /** Absolute directory of the skill package as the scan found it. */
  dir: string;
  /** Sidecar identity: frontmatter `name:`. */
  name: string;
  /** ISO-8601 stamp of the pass. */
  at: string;
  reason: string;
  /** Set when a consolidation folded this skill into an umbrella. */
  absorbedInto?: string;
  lock?: LockOptions;
}

export interface ArchivedSkill {
  name: string;
  from: string;
  to: string;
  reason: string;
  absorbedInto?: string;
}

export async function archiveSkill(
  options: ArchiveSkillOptions,
): Promise<ArchivedSkill> {
  const directory = skillsArchiveDir(options.skillsDir);
  await mkdir(directory, { recursive: true });
  const to = await freeDestination(directory, options.name, "", options.at);
  await move(options.dir, to);
  await updateUsage(
    options.skillsDir,
    (sidecar) => {
      const record = sidecar[options.name];
      if (!record) return;
      record.state = "archived";
      record.archived_at = options.at;
      if (options.absorbedInto !== undefined) {
        record.absorbed_into = options.absorbedInto;
      }
    },
    options.lock ?? {},
  );
  return {
    name: options.name,
    from: options.dir,
    to,
    reason: options.reason,
    ...(options.absorbedInto !== undefined && { absorbedInto: options.absorbedInto }),
  };
}

export interface RestoreOptions {
  at: string;
  lock?: LockOptions;
}

/** `argus curator restore <name>`'s semantics: the exact inverse of archiving. */
export async function restoreSkill(
  skillsDir: string,
  name: string,
  options: RestoreOptions,
): Promise<{ from: string; to: string }> {
  const from = join(skillsArchiveDir(skillsDir), name);
  if (!(await directoryExists(from))) {
    throw new Error(`curator restore: no archived skill named ${name}`);
  }
  const to = join(skillsDir, name);
  await move(from, to);
  await updateUsage(
    skillsDir,
    (sidecar) => {
      const record = sidecar[name];
      if (!record) return;
      record.state = "active";
      record.archived_at = null;
      delete record.absorbed_into;
      // Restoring IS activity: without this the next pass archives it again.
      record.last_used_at = options.at;
    },
    options.lock ?? {},
  );
  return { from, to };
}

/** Drop the index line pointing at `<slug>.md`; other lines are untouched. */
async function dropIndexLine(memoryDir: string, slug: string): Promise<void> {
  const path = join(memoryDir, "MEMORY.md");
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  const existing = await file.text();
  const kept = existing
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => memoryIndexTarget(line) !== `${slug}.md`);
  const next = `${kept.join("\n")}\n`;
  if (next !== existing) await Bun.write(path, next);
}

/** Move one per-fact file into the memory archive and de-index it. */
export async function archiveFact(
  memoryDir: string,
  slug: string,
  options: { at: string },
): Promise<{ slug: string; from: string; to: string }> {
  const directory = memoryArchiveDir(memoryDir);
  await mkdir(directory, { recursive: true });
  const from = join(memoryDir, `${slug}.md`);
  const to = await freeDestination(directory, slug, ".md", options.at);
  await move(from, to);
  await dropIndexLine(memoryDir, slug);
  return { slug, from, to };
}
