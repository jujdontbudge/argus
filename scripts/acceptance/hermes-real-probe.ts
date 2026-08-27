#!/usr/bin/env bun
/**
 * Ticket #108 — how close can the `real` half of `ARGUS_LIVE_HERMES` get
 * without writing the real `~/.hermes`?
 *
 * The gate's `real` half (`src/harness/hermes-live-gate.ts`) asks for
 * `~/.hermes/profiles/argus-*​/state.db` holding an assistant row. That path
 * does not exist here and cannot be made to exist by reading: it is created by
 * `argus up`'s binding, which MKDIRS INSIDE the real home. So the half itself
 * is unrunnable under the house rule, permanently — see `hermes-real-108.txt`.
 *
 * What IS reachable is the claim UNDER the half: that a real Hermes, with a
 * real provider that answers, persists an assistant row the UNMODIFIED
 * production source can read (research §7's caveat, positive form). Johan's
 * daily-driver `~/.hermes/state.db` is exactly such a database — written by
 * the same installed Hermes, from turns that were really answered. This probe
 * reads it, and never writes it:
 *
 *   1. APFS clonefile (`cp -c`) the real `state.db` into a scratch tree laid
 *      out the way `createHermesSource` expects. A clone is a read of the
 *      source and a copy-on-write allocation elsewhere; the source's inode,
 *      size and mtime are checked unchanged afterwards.
 *   2. Drive `createHermesSource` — the production source, unmodified — over
 *      the CLONE. Never over `~/.hermes`, because the production reader opens
 *      `mode=ro` but SQLite may still want to materialise `-shm` for a WAL,
 *      and "may still want to" is a write.
 *   3. Report what the real rows are, including the #100 shape-contract line
 *      the reader lifts off the schema.
 *
 * It reads only `state.db`. It never opens `.env`, `auth.json`, or any
 * credential, and it runs no `hermes` subcommand — `hermes profile list` was
 * MEASURED to create `logs/agent.log` under its `HERMES_HOME`, so even the
 * listing commands write.
 *
 *   bun scripts/acceptance/hermes-real-probe.ts [--scratch <dir>] [--tail <n>]
 */
import { constants, Database } from "bun:sqlite";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createHermesSource } from "../../src/tailing/hermes.ts";
import type { MessageEvent, SessionMetaEvent, TailEvent } from "../../src/tailing/events.ts";

const REAL_ROOT = join(homedir(), ".hermes");
const REAL_DB = join(REAL_ROOT, "state.db");
/** The clone's directory name. `argus-` is what `listFiles` filters on. */
const CLONE_PROFILE = "argus-real-108";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** inode/size/mtime, the three things a write to `state.db` would move. */
async function fingerprint(file: string): Promise<string> {
  const info = await stat(file);
  return `ino=${info.ino} size=${info.size} mtime=${Math.floor(info.mtimeMs)}`;
}

const scratch =
  flag("scratch") ?? (await mkdtemp(join(tmpdir(), "t108-hermes-probe-")));
const tailWindow = Number(flag("tail") ?? 400);

const before = await fingerprint(REAL_DB);
console.log(`real   ${REAL_DB}`);
console.log(`       ${before}`);

const profileDir = join(scratch, "profiles", CLONE_PROFILE);
await mkdir(profileDir, { recursive: true });
const clone = join(profileDir, "state.db");

// `-wal` and `-shm` come too, and they are not an optimisation. The real
// database is in WAL mode, and a `mode=ro` open of a WAL database with no
// companion `-shm` fails SQLITE_CANTOPEN — measured, see the evidence file.
// SQLite would have to CREATE that `-shm` to proceed, which is precisely why
// the production source is never pointed at `~/.hermes` in place.
const started = Bun.nanoseconds();
for (const suffix of ["", "-wal", "-shm"]) {
  const from = `${REAL_DB}${suffix}`;
  if (!(await Bun.file(from).exists())) continue;
  const cp = Bun.spawn(["cp", "-c", from, `${clone}${suffix}`], { stderr: "inherit" });
  if ((await cp.exited) !== 0) throw new Error(`clonefile failed: ${from}`);
}
const cloneMs = (Bun.nanoseconds() - started) / 1e6;

const after = await fingerprint(REAL_DB);
console.log(`       ${after}`);
console.log(
  `clone  ${clone}\n       ${cloneMs.toFixed(1)}ms  source ${before === after ? "UNCHANGED" : "CHANGED — STOP"}`,
);
if (before !== after) throw new Error("the real state.db moved during the clone");

// ---------------------------------------------------------------------------
// what the real database actually holds
// ---------------------------------------------------------------------------
const db = new Database(
  `${pathToFileURL(clone).href}?mode=ro&immutable=0`,
  constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
);
// The same read `hermes-drive.ts:73` makes, so the number here is directly
// comparable to the `schema_version 15` #47 recorded for a scratch profile.
const schemaVersion =
  db.query<{ version: number }, []>("SELECT version FROM schema_version").get()?.version ?? null;
const tables = db
  .query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  )
  .all()
  .map(({ name }) => name);
const candidates = db
  .query<{ n: number }, []>(
    "SELECT count(*) AS n FROM messages WHERE active = 1 AND role = 'assistant' AND content IS NOT NULL",
  )
  .get()?.n ?? 0;
const maximum = db.query<{ id: number | null }, []>("SELECT max(id) AS id FROM messages").get()?.id ?? 0;
const byRole = db
  .query<{ n: number; role: string | null }, []>(
    "SELECT role, count(*) AS n FROM messages WHERE active = 1 GROUP BY role ORDER BY n DESC",
  )
  .all();
db.close();

console.log(`\nschema schema_version.version ${schemaVersion}`);
console.log(`       tables ${tables.join(", ")}`);
console.log(`rows   max(id) ${maximum} · assistant rows with content ${candidates}`);
for (const { n, role } of byRole) console.log(`       ${String(role).padEnd(12)} ${n}`);

// ---------------------------------------------------------------------------
// the production source, unmodified, over the clone
// ---------------------------------------------------------------------------
const source = createHermesSource({ hermesRoot: scratch });
const files = await source.listFiles();
console.log(`\nsource createHermesSource({ hermesRoot: <scratch> }).listFiles()`);
for (const file of files) console.log(`       ${file}`);

// A tail window, not the whole 2.8GB history: `read` is offset-driven and this
// is the same call the Tailer makes on every poll after the first.
const offset = Math.max(0, maximum - tailWindow);
// `readNewLines` is optional on `TranscriptSource` — but the Hermes source is
// the reason it exists, so its absence is a contract break worth naming here.
if (source.readNewLines === undefined) {
  throw new Error("createHermesSource returned no readNewLines — the SQLite reader is gone");
}
const read = await source.readNewLines(files[0]!, offset);
const parser = source.createParser(files[0]!);
const events: TailEvent[] = read.lines.flatMap((line) => parser.parseLine(line));

const messages = events.filter((e): e is MessageEvent => e.type === "message");
const metas = events.filter((e): e is SessionMetaEvent => e.type === "session-meta");
const assistants = messages.filter(({ role }) => role === "assistant");

console.log(`       readNewLines(file, ${offset}) -> ${read.lines.length} lines, next offset ${read.offset}`);
console.log(`       session-meta ${metas.length} · messages ${messages.length} · assistant ${assistants.length}`);

const sample = assistants.at(-1);
if (sample === undefined) {
  console.log(`\nVERDICT  NO assistant row in the last ${tailWindow} ids — §7's caveat NOT retired here`);
} else {
  const meta = metas.find(({ sessionId }) => sessionId === sample.sessionId);
  console.log(`\nassistant row, as the production parser emits it`);
  console.log(`       session   ${sample.sessionId}`);
  console.log(`       model     ${meta?.model ?? "(meta outside the window)"}`);
  console.log(`       candidate ${sample.candidate}`);
  console.log(`       chars     ${sample.text.length}`);
  console.log(`\nVERDICT  a real Hermes assistant row parsed by the unmodified source`);
}

// The text itself is Johan's private conversation. It is counted, never printed.
console.log(`\nreal   ${await fingerprint(REAL_DB)}  (re-checked at exit)`);
console.log(`scratch ${scratch}`);
