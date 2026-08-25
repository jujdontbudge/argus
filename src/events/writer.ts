import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { hashText } from "../matching";
import {
  EVENT_SCHEMA_VERSION,
  type ArgusEvent,
  type EventAgent,
  type EventKind,
} from "./schema.ts";

export interface EventInput {
  agent: EventAgent;
  kind: EventKind;
  message: string;
  sessionId: string;
}

export interface EventWriterOptions {
  now?: () => Date;
}

export interface EventWriteResult {
  event: ArgusEvent;
  path: string;
  status: "written" | "duplicate";
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * The id excludes wall time and message text on purpose: the same native hook
 * may fire twice, but one agent/session/state transition is one durable event.
 */
function eventId(input: EventInput): string {
  return hashText(
    [EVENT_SCHEMA_VERSION, input.agent, input.sessionId, input.kind].join("\u0000"),
  );
}

export async function writeEvent(
  repo: string,
  input: EventInput,
  options: EventWriterOptions = {},
): Promise<EventWriteResult> {
  const id = eventId(input);
  const event: ArgusEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id,
    kind: input.kind,
    agent: input.agent,
    sessionId: input.sessionId,
    repo,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    message: input.message,
  };
  const directory = join(repo, ".argus", "events");
  const path = join(directory, `v${EVENT_SCHEMA_VERSION}-${input.kind}-${id}.json`);
  await mkdir(directory, { recursive: true });
  try {
    const file = await open(path, "wx");
    try {
      await file.writeFile(`${JSON.stringify(event, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return { event, path, status: "written" };
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
    const existing = (await Bun.file(path).json()) as ArgusEvent;
    return { event: existing, path, status: "duplicate" };
  }
}
