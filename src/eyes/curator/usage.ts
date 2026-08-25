/**
 * The skills usage sidecar — `.argus/skills/.usage.json`.
 *
 * LIFTED (research #16 §8(i)): the per-skill record schema is Hermes'
 * `tools/skill_usage.py:460-474` `_empty_record` verbatim, keyed by the
 * skill's frontmatter `name:`, and maintained with the same lock-file +
 * atomic-replace discipline (`tools/skill_usage.py:90-123,496-518`). Keeping
 * the field names byte-identical is deliberate: anyone who knows the Hermes
 * sidecar can read this one, and the deterministic transition tier ports
 * across unchanged.
 *
 * RE-SPECCED: the telemetry SOURCE. Hermes bumps these counters from its own
 * tool calls; Argus skills are exercised by Claude/Codex sessions Hermes
 * never sees, so the Reviewer is the writer — it bumps a record every time it
 * creates or patches a skill, and `created_by` carries the registry
 * provenance split (Johan-authored skills are pinned, so the curator can
 * never touch them).
 */
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Who wrote the skill: the Reviewer on its own, or Johan through it. */
export type UsageAuthor = "agent" | "johan";

export type UsageState = "active" | "stale" | "archived";

export interface UsageRecord {
  created_by: UsageAuthor;
  use_count: number;
  view_count: number;
  patch_count: number;
  last_used_at: string | null;
  last_viewed_at: string | null;
  last_patched_at: string | null;
  created_at: string;
  state: UsageState;
  pinned: boolean;
  archived_at: string | null;
  /** Argus addition: the umbrella a consolidation folded this skill into. */
  absorbed_into?: string;
}

/** Keyed by skill name (frontmatter `name:`, directory-name fallback). */
export type UsageSidecar = Record<string, UsageRecord>;

const SIDECAR = ".usage.json";
const LOCK = ".usage.json.lock";

export function usagePath(skillsDir: string): string {
  return join(skillsDir, SIDECAR);
}

export function emptyRecord(
  createdAt: string,
  createdBy: UsageAuthor = "agent",
): UsageRecord {
  return {
    created_by: createdBy,
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: createdAt,
    state: "active",
    // Johan's skills belong to Johan: pinned means the curator never judges it.
    pinned: createdBy === "johan",
    archived_at: null,
  };
}

/** Newest of the three activity stamps; null when the skill was never used. */
export function latestActivityAt(record: UsageRecord): string | null {
  const stamps = [
    record.last_used_at,
    record.last_viewed_at,
    record.last_patched_at,
  ].filter((stamp): stamp is string => typeof stamp === "string");
  if (stamps.length === 0) return null;
  return stamps.reduce((newest, stamp) =>
    Date.parse(stamp) > Date.parse(newest) ? stamp : newest,
  );
}

function isRecord(value: unknown): value is UsageRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.created_at === "string" &&
    typeof record.state === "string" &&
    typeof record.pinned === "boolean"
  );
}

/** Read the sidecar. A missing or torn file reads as no records, never throws. */
export async function readUsage(skillsDir: string): Promise<UsageSidecar> {
  const file = Bun.file(usagePath(skillsDir));
  if (!(await file.exists())) return {};
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { skills } = parsed as Record<string, unknown>;
  if (typeof skills !== "object" || skills === null) return {};
  const sidecar: UsageSidecar = {};
  for (const [name, value] of Object.entries(skills)) {
    if (isRecord(value)) sidecar[name] = value;
  }
  return sidecar;
}

/** Atomic replace: a reader never sees a half-written sidecar. */
export async function writeUsage(
  skillsDir: string,
  sidecar: UsageSidecar,
): Promise<void> {
  await mkdir(skillsDir, { recursive: true });
  const path = usagePath(skillsDir);
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, `${JSON.stringify({ skills: sidecar }, null, 2)}\n`);
  await rename(temporary, path);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export interface LockOptions {
  /** Give up waiting and break the lock after this long. */
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Hold the sidecar lock for the duration of `body`. A lock whose owner is
 * dead is reclaimed immediately, and one held past the timeout is broken —
 * an eye must never hang on a stale lock file.
 */
export async function withUsageLock<T>(
  skillsDir: string,
  body: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 10;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  await mkdir(skillsDir, { recursive: true });
  const path = join(skillsDir, LOCK);
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const owner = Number((await Bun.file(path).text().catch(() => "")).trim());
      if ((Number.isInteger(owner) && !isAlive(owner)) || now() >= deadline) {
        await unlink(path).catch(() => {});
        continue;
      }
      await sleep(pollMs);
    }
  }
  try {
    return await body();
  } finally {
    await unlink(path).catch(() => {});
  }
}

/** Read-modify-write the sidecar under the lock; returns the written state. */
export async function updateUsage(
  skillsDir: string,
  mutate: (sidecar: UsageSidecar) => void,
  options: LockOptions = {},
): Promise<UsageSidecar> {
  return await withUsageLock(
    skillsDir,
    async () => {
      const sidecar = await readUsage(skillsDir);
      mutate(sidecar);
      await writeUsage(skillsDir, sidecar);
      return sidecar;
    },
    options,
  );
}

export interface SkillWriteOptions {
  /** ISO-8601 stamp of the write (the eye's clock, never the wall clock). */
  at: string;
  createdBy: UsageAuthor;
  lock?: LockOptions;
}

/**
 * The Reviewer's telemetry hook: record that it just created or patched these
 * skills. First sight seeds the record (this is also what makes the curator's
 * first pass safe — see `applyAutomaticTransitions`); later writes bump the
 * patch clock. Johan's ownership, once recorded, is never downgraded.
 */
export async function recordSkillWrites(
  skillsDir: string,
  names: readonly string[],
  options: SkillWriteOptions,
): Promise<void> {
  if (names.length === 0) return;
  await updateUsage(
    skillsDir,
    (sidecar) => {
      for (const name of names) {
        const existing = sidecar[name];
        if (!existing) {
          sidecar[name] = {
            ...emptyRecord(options.at, options.createdBy),
            last_patched_at: options.at,
          };
          continue;
        }
        existing.patch_count += 1;
        existing.last_patched_at = options.at;
        if (options.createdBy === "johan") {
          existing.created_by = "johan";
          existing.pinned = true;
        }
        // A patch is activity: a stale skill that gets rewritten is alive again.
        if (existing.state === "stale") existing.state = "active";
      }
    },
    options.lock ?? {},
  );
}
