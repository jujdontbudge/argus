import { expect, test } from "bun:test";
import { constants, Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createHermesSource } from "./hermes";
import { Tailer } from "./tailer";

const hermesRoot = join(homedir(), ".hermes");

function profileWithPersistedAssistant(): string | undefined {
  const profiles = join(hermesRoot, "profiles");
  if (!existsSync(profiles)) return undefined;
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("argus-")) continue;
    const file = join(profiles, entry.name, "state.db");
    if (!existsSync(file)) continue;
    let db: Database | undefined;
    try {
      const uri = `${pathToFileURL(file).href}?mode=ro&immutable=0`;
      db = new Database(
        uri,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
      );
      const row = db
        .query<{ present: number }, []>(
          `SELECT 1 AS present
           FROM messages
           WHERE role = 'assistant' AND active = 1
           LIMIT 1`,
        )
        .get();
      if (row?.present === 1) return file;
    } catch {
      // Version/schema drift makes this profile ineligible for the smoke test.
    } finally {
      db?.close();
    }
  }
  return undefined;
}

const liveProfile = profileWithPersistedAssistant();

test.skipIf(liveProfile === undefined)(
  "live profile persists an assistant row that the read-only source can tail (§7 caveat)",
  async () => {
    const events = await new Tailer(createHermesSource({ hermesRoot })).catchUp();
    expect(
      events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.file === liveProfile,
      ),
    ).toBe(true);
  },
  30_000,
);
