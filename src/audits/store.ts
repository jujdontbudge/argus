import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProvenanceAudit } from "../provenance/index.ts";
import type { EyeName } from "../supervisor/runtime.ts";

export interface MalformedEventAudit {
  type: "event-malformed";
  file: string;
  raw: string;
  reason: string;
}

export type AuditDetails = ProvenanceAudit | MalformedEventAudit;

export interface DurableAudit {
  acknowledgedAt: string | null;
  details: AuditDetails;
  firstSeenAt: string;
  id: string;
  repo: string;
  sourceEye: EyeName | "legacy";
  type: AuditDetails["type"];
}

function directory(repo: string): string {
  return join(repo, ".argus", "audits");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function identity(audit: AuditDetails): unknown {
  // Collapse only repetitions that name the same underlying fault. Everything
  // else retains every detail, deliberately biasing toward a new alarm when
  // there is any doubt that two observations are the same incident.
  switch (audit.type) {
    case "claude-origin-kind-refused":
      return { type: audit.type, kind: audit.kind };
    // One alarm per unknown shape fact, not one per record carrying it (#100).
    // The eyes are always-on and a drifted CLI writes the same new field on
    // every record it produces; without this the first cosmetic rename would
    // bury every other alarm in `argus status` within a minute.
    case "record-shape-drift":
      return {
        type: audit.type,
        source: audit.source,
        dimension: audit.dimension,
        path: audit.path,
        token: audit.token,
      };
    case "send-expired":
      return {
        type: audit.type,
        sessionId: audit.sessionId,
        sendId: audit.sendId,
        text: audit.text,
      };
    case "dispatch-expired":
      return { type: audit.type, sessionId: audit.sessionId };
    default:
      return audit;
  }
}

function auditId(repo: string, audit: AuditDetails): string {
  return createHash("sha256")
    .update(JSON.stringify(stable({ repo, audit: identity(audit) })), "utf8")
    .digest("hex");
}

function pathFor(repo: string, id: string): string {
  return join(directory(repo), `${id}.json`);
}

export async function recordAudits(
  repo: string,
  sourceEye: DurableAudit["sourceEye"],
  audits: readonly AuditDetails[],
): Promise<void> {
  if (audits.length === 0) return;
  await mkdir(directory(repo), { recursive: true });
  for (const details of audits) {
    const id = auditId(repo, details);
    const record: DurableAudit = {
      acknowledgedAt: null,
      details,
      firstSeenAt: new Date().toISOString(),
      id,
      repo,
      sourceEye,
      type: details.type,
    };
    const temporary = join(
      directory(repo),
      `.audit.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        flag: "wx",
      });
      try {
        await link(temporary, pathFor(repo, id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/**
 * Import #53's pre-#61 machine-global origin markers without deleting them.
 * Keeping the source markers makes this idempotent and lets a disabled repo be
 * imported if it is enrolled again later.
 */
export async function importLegacyOriginAudits(
  registryPath: string,
  enabledRepos: readonly string[],
): Promise<void> {
  const legacyDirectory = `${registryPath}.audits/claude-origin-kind-refusals`;
  const enabled = new Set(enabledRepos);
  const names = await readdir(legacyDirectory).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const value = (await Bun.file(join(legacyDirectory, name)).json()) as Record<
            string,
            unknown
          >;
          if (
            typeof value.kind !== "string" ||
            typeof value.repo !== "string" ||
            !enabled.has(value.repo) ||
            typeof value.sessionId !== "string" ||
            typeof value.ts !== "string"
          ) {
            return;
          }
          await recordAudits(value.repo, "legacy", [
            {
              type: "claude-origin-kind-refused",
              kind: value.kind,
              sessionId: value.sessionId,
              ts: value.ts,
            },
          ]);
        } catch {
          // One damaged legacy marker must not hide the other active alarms.
        }
      }),
  );
}

export async function readAudits(repo: string): Promise<DurableAudit[]> {
  const names = await readdir(directory(repo)).catch(() => [] as string[]);
  const audits: DurableAudit[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    try {
      const value = (await Bun.file(join(directory(repo), name)).json()) as DurableAudit;
      if (
        value.repo === repo &&
        typeof value.id === "string" &&
        typeof value.type === "string" &&
        typeof value.firstSeenAt === "string" &&
        (value.acknowledgedAt === null || typeof value.acknowledgedAt === "string")
      ) {
        audits.push(value);
      }
    } catch {
      // A damaged audit record must not make the remaining alarms disappear.
    }
  }
  return audits;
}

export async function acknowledgeAudit(repo: string, id: string): Promise<boolean> {
  const path = pathFor(repo, id);
  let record: DurableAudit;
  try {
    record = (await Bun.file(path).json()) as DurableAudit;
  } catch {
    return false;
  }
  if (record.id !== id || record.repo !== repo) return false;
  if (record.acknowledgedAt !== null) return true;
  const acknowledged: DurableAudit = {
    ...record,
    acknowledgedAt: new Date().toISOString(),
  };
  const temporary = join(
    directory(repo),
    `.ack.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(acknowledged, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}
