import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProvenanceAudit } from "./classifier.ts";

export interface OriginRefusalAudit {
  kind: string;
  repo: string;
  sessionId: string;
  ts: string;
}

function auditDirectory(registryPath: string): string {
  return `${registryPath}.audits/claude-origin-kind-refusals`;
}

function auditPath(registryPath: string, kind: string): string {
  const name = createHash("sha256").update(kind, "utf8").digest("hex");
  return join(auditDirectory(registryPath), `${name}.json`);
}

export async function recordOriginRefusals(
  registryPath: string,
  repo: string,
  audits: readonly ProvenanceAudit[],
): Promise<ProvenanceAudit[]> {
  const refusals = audits.filter(
    (audit): audit is Extract<ProvenanceAudit, { type: "claude-origin-kind-refused" }> =>
      audit.type === "claude-origin-kind-refused",
  );
  if (refusals.length === 0) return [];
  await mkdir(auditDirectory(registryPath), { recursive: true });
  const recorded: ProvenanceAudit[] = [];
  for (const audit of refusals) {
    const directory = auditDirectory(registryPath);
    const temporary = join(
      directory,
      `.origin-refusal.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ kind: audit.kind, repo, sessionId: audit.sessionId, ts: audit.ts })}\n`,
        { flag: "wx" },
      );
      try {
        await link(temporary, auditPath(registryPath, audit.kind));
        recorded.push(audit);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return recorded;
}

export async function readOriginRefusals(
  registryPath: string,
): Promise<OriginRefusalAudit[]> {
  const refusals: OriginRefusalAudit[] = [];
  const directory = auditDirectory(registryPath);
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    try {
      const value = (await Bun.file(join(directory, name)).json()) as Record<
        string,
        unknown
      >;
      if (
        typeof value.kind === "string" &&
        typeof value.repo === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.ts === "string"
      ) {
        refusals.push({
          kind: value.kind,
          repo: value.repo,
          sessionId: value.sessionId,
          ts: value.ts,
        });
      }
    } catch {
      // A partial audit marker must not make `argus status` itself go quiet.
    }
  }
  return refusals;
}
