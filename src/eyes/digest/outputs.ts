/**
 * The Digest's two output surfaces (SPEC §5.4):
 *
 * - `.argus/sessions/<ticket>-<id>.md` (`adhoc-<id>.md` when ticketless) — the
 *   per-session running digest: frontmatter (`agent`, `ticket`, `status`,
 *   `started_by`, `johan_touched`) patched in place, narrative appended below.
 *   The `status:` field IS the §6 slow-poll signal, so writes are atomic
 *   (temp + rename): a poll sweep can never read a torn digest.
 * - `.argus/sessions/INDEX.md` — one line per session, Hermes' zoom entry
 *   point (INDEX → digest → raw transcript).
 *
 * Sticky rules live here, not in callers: `johan_touched` never lowers once
 * true, and `dead` is terminal — a brain judgment cannot resurrect a session
 * the supervisor declared dead.
 */
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DigestStatus } from "./schema";

/** Hard storage ceiling for one running digest, including frontmatter. */
export const MAX_DIGEST_BYTES = 256 * 1024;
/** Retro may inspect at most this much digest data in one scan. */
export const MAX_DIGEST_LIST_BYTES = 4 * 1024 * 1024;
export const MAX_DIGEST_COUNT = 500;
const MAX_NARRATIVE_BYTES = 64 * 1024;
const BODY_TRUNCATION = "… older digest narrative truncated by Argus …\n\n";

export class DigestSizeError extends Error {
  constructor(path: string, size: number, limit: number, kind = "digest") {
    super(`${kind} ${path} is ${size} bytes and exceeds the ${limit}-byte budget`);
    this.name = "DigestSizeError";
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function utf8Prefix(text: string, limit: number, marker: string): string {
  if (byteLength(text) <= limit) return text;
  const markerBytes = byteLength(marker);
  const prefix = Buffer.from(text)
    .subarray(0, Math.max(0, limit - markerBytes))
    .toString("utf8")
    .replace(/�+$/, "");
  return `${prefix}${marker}`;
}

function compactBody(body: string, limit: number): string {
  if (byteLength(body) <= limit) return body;
  const markerBytes = byteLength(BODY_TRUNCATION);
  const tail = Buffer.from(body)
    .subarray(Math.max(0, byteLength(body) - Math.max(0, limit - markerBytes)))
    .toString("utf8")
    .replace(/^�+/, "");
  return `${BODY_TRUNCATION}${tail}`;
}

async function boundedFileSize(path: string): Promise<number | null> {
  try {
    const size = (await stat(path)).size;
    if (size > MAX_DIGEST_BYTES) {
      throw new DigestSizeError(path, size, MAX_DIGEST_BYTES);
    }
    return size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Session identity written once at file creation and preserved after. */
export interface DigestSeed {
  agent: string;
  ticket?: string;
  startedBy: "johan" | "hermes";
}

/** The effective frontmatter after an update. */
export interface DigestFrontmatter extends DigestSeed {
  status: DigestStatus;
  johanTouched: boolean;
}

export interface DigestPatch {
  /** Latest-wins, except `dead` which is terminal. */
  status?: DigestStatus;
  /** Sticky-true. */
  johanTouched?: boolean;
  /** Appended to the body under a timestamp heading. */
  narrative?: { ts: string; text: string };
}

/** SPEC §5.4 naming: `<ticket>-<id>.md`, `adhoc-<id>.md` when ticketless. */
export function digestFileName(
  ticket: string | undefined,
  sessionId: string,
): string {
  return `${ticket ?? "adhoc"}-${sessionId}.md`;
}

const STATUSES: readonly string[] = ["running", "blocked", "done", "dead"];

function renderFrontmatter(frontmatter: DigestFrontmatter): string {
  return [
    "---",
    `agent: ${frontmatter.agent}`,
    `ticket: ${frontmatter.ticket ?? "null"}`,
    `status: ${frontmatter.status}`,
    `started_by: ${frontmatter.startedBy}`,
    `johan_touched: ${frontmatter.johanTouched}`,
    "---",
    "",
  ].join("\n");
}

interface ParsedDigest {
  frontmatter: DigestFrontmatter;
  body: string;
}

/**
 * Parse an existing digest leniently: unknown keys are preserved-by-ignoring
 * (the file is rewritten from parsed state), malformed frontmatter falls back
 * to the seed — a hand-edited digest must never take the eye down.
 */
function parseDigest(text: string, seed: DigestSeed): ParsedDigest {
  const fallback: ParsedDigest = {
    frontmatter: { ...seed, status: "running", johanTouched: false },
    body: text.replace(/^\n+/, ""),
  };
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return fallback;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (field) fields.set(field[1]!, field[2]!.trim());
  }
  const status = fields.get("status");
  const ticket = fields.get("ticket");
  return {
    frontmatter: {
      agent: fields.get("agent") ?? seed.agent,
      ...(ticket !== undefined && ticket !== "null"
        ? { ticket }
        : seed.ticket !== undefined && { ticket: seed.ticket }),
      startedBy:
        fields.get("started_by") === "johan"
          ? "johan"
          : fields.get("started_by") === "hermes"
            ? "hermes"
            : seed.startedBy,
      status:
        status !== undefined && STATUSES.includes(status)
          ? (status as DigestStatus)
          : "running",
      johanTouched: fields.get("johan_touched") === "true",
    },
    body: text.slice(match[0].length).replace(/^\n/, ""),
  };
}

/** Atomic write (temp + rename): the poll sweep never reads a torn digest. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, contents);
  await rename(temporary, path);
}

/**
 * Create-or-patch one session digest. Returns the effective frontmatter so
 * callers (and the INDEX line) reflect what the sticky rules actually kept.
 */
export async function applyDigestUpdate(
  sessionsDir: string,
  fileName: string,
  seed: DigestSeed,
  patch: DigestPatch,
): Promise<DigestFrontmatter> {
  await mkdir(sessionsDir, { recursive: true });
  const path = join(sessionsDir, fileName);
  const file = Bun.file(path);
  const existingSize = await boundedFileSize(path);
  const existingText = existingSize === null ? null : await file.text();
  const existing: ParsedDigest =
    existingText === null
      ? { frontmatter: { ...seed, status: "running", johanTouched: false }, body: "" }
      : parseDigest(existingText, seed);

  const frontmatter: DigestFrontmatter = {
    ...existing.frontmatter,
    status:
      existing.frontmatter.status === "dead"
        ? "dead"
        : (patch.status ?? existing.frontmatter.status),
    johanTouched: existing.frontmatter.johanTouched || patch.johanTouched === true,
  };
  const narrative =
    patch.narrative === undefined
      ? undefined
      : utf8Prefix(
          patch.narrative.text.replace(/\n*$/, ""),
          MAX_NARRATIVE_BYTES,
          "\n… digest narrative truncated by Argus …",
        );
  const appendedBody =
    narrative === undefined
      ? existing.body
      : `${existing.body}## ${patch.narrative!.ts}\n\n${narrative}\n`;
  const renderedFrontmatter = renderFrontmatter(frontmatter);
  const bodyBudget =
    MAX_DIGEST_BYTES - byteLength(renderedFrontmatter) - byteLength("\n\n");
  const body = compactBody(appendedBody, Math.max(0, bodyBudget));
  const next = `${renderedFrontmatter}\n${body}`.replace(/\n?$/, "\n");
  const nextBytes = byteLength(next);
  if (nextBytes > MAX_DIGEST_BYTES) {
    throw new DigestSizeError(path, nextBytes, MAX_DIGEST_BYTES, "rendered digest");
  }
  if (existingText === null || existingText !== next) {
    await writeAtomic(path, next);
  }
  return frontmatter;
}

/** One INDEX.md line's fields; `file` is the line's identity. */
export interface IndexEntry {
  file: string;
  agent: string;
  ticket?: string;
  status: DigestStatus;
  startedBy: "johan" | "hermes";
  johanTouched: boolean;
  /** Omitted: the existing line's summary is preserved. */
  summary?: string;
}

const INDEX_HEADER = "# Session index\n";
const INDEX_LINE = /^- (\S+\.md) — .* — (.*)$/;

function renderIndexLine(entry: IndexEntry, summary: string): string {
  return (
    `- ${entry.file} — agent=${entry.agent} ticket=${entry.ticket ?? "null"} ` +
    `status=${entry.status} started_by=${entry.startedBy} ` +
    `johan_touched=${entry.johanTouched} — ${summary}`
  );
}

/**
 * Mutual exclusion for INDEX.md across eye PROCESSES, not just tasks: `mkdir`
 * is atomic on POSIX, so the lock directory is a filesystem-wide critical
 * section. A lock older than `staleMs` belongs to a crashed writer and is
 * reclaimed — INDEX updates must never wedge behind a corpse.
 */
async function withIndexLock<T>(
  sessionsDir: string,
  body: () => Promise<T>,
  pollMs = 5,
  staleMs = 10_000,
): Promise<T> {
  const lock = join(sessionsDir, ".index.lock");
  for (;;) {
    try {
      await mkdir(lock, { recursive: false });
      break;
    } catch {
      try {
        const held = await stat(lock);
        if (Date.now() - held.mtimeMs > staleMs) {
          await rmdir(lock).catch(() => {});
        }
      } catch {
        // The holder released between attempts; retry immediately.
      }
      await Bun.sleep(pollMs);
    }
  }
  try {
    return await body();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

/**
 * Upsert one session's INDEX.md line under the lock: read-modify-write is a
 * critical section, so concurrent writers (two eyes, two processes) lose no
 * lines and duplicate none.
 */
export async function updateIndex(
  sessionsDir: string,
  entry: IndexEntry,
): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  await withIndexLock(sessionsDir, async () => {
    const path = join(sessionsDir, "INDEX.md");
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : INDEX_HEADER;
    const lines = existing.replace(/\n+$/, "").split("\n");
    const at = lines.findIndex(
      (line) => line.match(INDEX_LINE)?.[1] === entry.file,
    );
    const summary =
      entry.summary ?? (at >= 0 ? lines[at]!.match(INDEX_LINE)![2]! : "");
    const line = renderIndexLine(entry, summary);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
    await writeAtomic(path, `${lines.join("\n")}\n`);
  });
}

/** A digest read back off disk: the §5.5 Retro eye's transcript signal. */
export interface StoredDigest {
  fileName: string;
  /** The session id `digestFileName` encoded (ids may contain dashes). */
  sessionId: string;
  frontmatter: DigestFrontmatter;
  body: string;
}

/** Neutral seed for reads: it only shows through on malformed frontmatter. */
const READ_SEED: DigestSeed = { agent: "unknown", startedBy: "johan" };

/** Inverse of `digestFileName`: the ticket prefix, then the session id. */
function sessionIdOf(fileName: string): string {
  return fileName.replace(/\.md$/, "").split("-").slice(1).join("-");
}

/** Read one session digest, or null when it does not exist. */
export async function readDigest(
  sessionsDir: string,
  fileName: string,
): Promise<StoredDigest | null> {
  const path = join(sessionsDir, fileName);
  const size = await boundedFileSize(path);
  if (size === null) return null;
  const { frontmatter, body } = parseDigest(await Bun.file(path).text(), READ_SEED);
  return { fileName, sessionId: sessionIdOf(fileName), frontmatter, body };
}

/** Every session digest in the directory; INDEX.md is not one of them. */
export async function listDigests(sessionsDir: string): Promise<StoredDigest[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return []; // no sessions directory yet: no digests, not an error
  }
  const digestNames = names
    .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
    .sort();
  if (digestNames.length > MAX_DIGEST_COUNT) {
    throw new DigestSizeError(
      sessionsDir,
      digestNames.length,
      MAX_DIGEST_COUNT,
      "digest count",
    );
  }
  let totalBytes = 0;
  for (const name of digestNames) {
    const path = join(sessionsDir, name);
    const size = await boundedFileSize(path);
    if (size === null) continue;
    totalBytes += size;
    if (totalBytes > MAX_DIGEST_LIST_BYTES) {
      throw new DigestSizeError(
        sessionsDir,
        totalBytes,
        MAX_DIGEST_LIST_BYTES,
        "digest aggregate",
      );
    }
  }
  const digests: StoredDigest[] = [];
  for (const name of digestNames) {
    const digest = await readDigest(sessionsDir, name);
    if (digest) digests.push(digest);
  }
  return digests;
}
