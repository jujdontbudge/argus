/**
 * The ONE registry writer (SPEC §5). Everything that appends to
 * `.argus/registry/` goes through here.
 *
 * This module started as a private helper inside `src/events/notify.ts`,
 * where it served exactly one caller: the mission-control event send. Ticket
 * #55 added the second and third callers — the deployment row and the
 * follow-up send the worker dispatcher writes — and the audit's standing
 * warning about this build is that "a second registry writer that drifts from
 * the first" is the failure mode it keeps hitting. So the helper moved out
 * rather than being copied, and `notify.ts` now imports it.
 *
 * DURABILITY IS THE POINT, not a nicety. SPEC §5 rule 1 exists so a prompt can
 * never land before the registry can explain it, which is only true if the row
 * is on the disk — not in a page cache that a crash between write and spawn
 * would drop — by the time the agent process starts. Hence `fsync` on every
 * append, and hence every writer here returning only after it.
 */
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type { SendKind } from "../matching";
import type { SendRecord, SessionRecord } from "./registry";

/** Append one JSONL row and fsync it before returning. */
export async function appendDurably(path: string, row: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a");
  try {
    await file.write(`${JSON.stringify(row)}\n`, undefined, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * A deployment row plus the extra fields writers carry through. The reader
 * (`parseSessionsJsonl`) ignores unknown keys, so extras are additive by
 * construction — but they are typed here so a writer cannot invent a field
 * name that collides with one the reader means differently.
 */
export type SessionRow = SessionRecord & Record<string, unknown>;

/** A send row: the matcher's fields plus the delivery target it was aimed at. */
export type SendRow = SendRecord & {
  agent?: string;
  hash?: string;
  kind?: SendKind;
  surface?: string;
  workspace?: string;
};

/** SPEC §5 rule 1: the deployment, durable before the session starts. */
export async function appendSessionRow(file: string, row: SessionRow): Promise<void> {
  await appendDurably(file, row);
}

/** SPEC §5 rule 2: the follow-up, durable before it is typed. */
export async function appendSendRow(file: string, row: SendRow): Promise<void> {
  await appendDurably(file, row);
}
