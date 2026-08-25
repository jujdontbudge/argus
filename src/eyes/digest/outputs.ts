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
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { DigestStatus } from "./schema";

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
  const existing: ParsedDigest = (await file.exists())
    ? parseDigest(await file.text(), seed)
    : { frontmatter: { ...seed, status: "running", johanTouched: false }, body: "" };

  const frontmatter: DigestFrontmatter = {
    ...existing.frontmatter,
    status:
      existing.frontmatter.status === "dead"
        ? "dead"
        : (patch.status ?? existing.frontmatter.status),
    johanTouched: existing.frontmatter.johanTouched || patch.johanTouched === true,
  };
  const body =
    patch.narrative === undefined
      ? existing.body
      : `${existing.body}## ${patch.narrative.ts}\n\n${patch.narrative.text.replace(/\n*$/, "")}\n`;

  const next = `${renderFrontmatter(frontmatter)}\n${body}`.replace(/\n?$/, "\n");
  if (!(await file.exists()) || (await file.text()) !== next) {
    await writeAtomic(path, next);
  }
  return frontmatter;
}
