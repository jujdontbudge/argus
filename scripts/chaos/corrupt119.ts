/**
 * #119 H3: corrupt117.ts with its TIMING fixed. A copy, not an edit.
 *
 * WHY A COPY. #119 says a purely mechanical fix may go in place. This one is
 * not mechanical. corrupt117.ts fired its damage at SETTLE_MS = 25 s, before
 * any WAL checkpoint, when `archive.db` was still a 4,096-byte one-page file
 * with every row sitting in a 737 KB WAL. For `page-garbage` the offset
 *     Math.max(4096, Math.floor(size / 2 / 4096) * 4096)
 * then evaluates to Math.max(4096, 0) = 4096 — exactly EOF — so the write that
 * was meant to land in the MIDDLE of a b-tree appended a page past the end
 * instead, and SQLite takes its page count from the header and ignores it.
 * `truncate-half` cut a file holding no rows. Both were no-ops, which is why
 * all three modes returned byte-identical numbers.
 *
 * Fixing that needs an experimental design decision — force a checkpoint, or
 * seed until the file is big enough, and how big is big enough — not a typo
 * correction. And docs/acceptance/chaos117.txt §6 H3 and §7 quote corrupt117.ts
 * to explain WHY two of three modes established nothing; editing it in place
 * would leave that finding unreproducible from the tree. So corrupt117.ts stays
 * exactly as committed in 07a392e and this file carries the fix.
 *
 * WHAT CHANGED, AND NOTHING ELSE DID.
 *  1. A SEED phase replaces the 25 s settle. It appends traffic in batches and
 *     runs `PRAGMA wal_checkpoint(TRUNCATE)` each tick until the MAIN database
 *     file holds at least MIN_DB_PAGES pages, or SEED_TIMEOUT_MS elapses. The
 *     checkpoint is what moves rows out of the WAL and into the b-tree pages
 *     this scenario is supposed to be damaging. A checkpoint is not a write to
 *     any row; it changes no data and biases no outcome.
 *  2. `corrupt()` for `page-garbage` now REFUSES to apply and records why if
 *     the computed offset is not a whole page strictly inside the file. The
 *     degenerate write-past-EOF that made #117's result void can no longer
 *     happen silently — it becomes `applied: false` with the numbers attached.
 *  3. A CONTROL. Right after the damage, a fresh read-only connection runs
 *     `PRAGMA integrity_check` and the answer is recorded as
 *     `integrityImmediatelyAfterCorruption`. #117 could not tell "Argus did not
 *     notice" apart from "nothing was actually broken". This makes that
 *     distinction a recorded fact rather than an inference: if this control
 *     says `ok`, the corruption did not take and the run establishes nothing,
 *     and it will say so in its own output instead of leaving a reader to work
 *     it out afterwards.
 *  4. Modes are selectable on argv so #119 can re-run `page-garbage` alone.
 *  5. The one-line console summary now reports the SAME three channels the
 *     LOUD definition below names. #117's line printed
 *     `loud=${firstErrorAfterMs !== null}`, and `firstErrorAfterMs` only ever
 *     watches `health.json` and the watcher's liveness — it never looks at
 *     stderr, which the definition explicitly counts. So a run that wrote 90
 *     lines to stderr could print `loud=false`. The recorded `loud` object was
 *     always right; only the summary was not, and a summary that contradicts
 *     the file's own pre-registered definition is exactly the kind of thing
 *     that gets read instead of the JSON. The definition is unchanged; the
 *     line now matches it, and the channels are broken out so "loud where"
 *     never has to be reconstructed.
 *
 * OBSERVE_MS, POLL_MS, the LOUD and RECOVERABLE definitions, the single
 * unsupervised watcher and the reporting shape are all unchanged from #117, so
 * the numbers this produces are comparable with the ones already published.
 *
 * ---------------------------------------------------------------------------
 * The original #117 preamble, unchanged, follows.
 * ---------------------------------------------------------------------------
 *
 * #117 item 2: corrupt a live archive and find out whether the failure is LOUD
 * and whether recovery needs a human.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE WATCHER AND NOT A FLEET
 * ---------------------------------------------------------------------------
 * The question is about ONE file — `<repo>/.argus/archive.db` — and exactly one
 * process writes it: the archiver. A supervisor and four other eyes would add
 * restart policy, four more health files and four more RSS curves to a question
 * that has none of those in it, and the restart policy is already measured by
 * the main run. So this scenario runs a single real `argus watch archiver`
 * child, with `ARGUS_WATCH_OWNER_PID` set to this process so the watcher exits
 * on its own if this driver dies (src/watch.ts) — R4 teardown that does not
 * depend on this process getting to run any cleanup at all.
 *
 * NOT a supervised watcher, deliberately: under a supervisor a corrupted eye
 * that exits gets respawned, and "it came back" would be measuring restart
 * policy again instead of measuring whether the archive itself is recoverable.
 * Unsupervised, whatever this watcher does after corruption is the archiver's
 * own behaviour with nothing to hide behind.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CORRUPTIONS, AND WHAT EACH ONE IS ACTUALLY ASKING
 * ---------------------------------------------------------------------------
 * `wal-tail-garbage`   overwrite the last 512 bytes of `archive.db-wal` while
 *                      the archiver is live. SQLite checksums WAL frames, so
 *                      the DEFINED behaviour is to stop replaying at the first
 *                      bad frame. This asks whether Argus loses only the
 *                      unreplayable tail, or something worse.
 * `page-garbage`       overwrite 4 KiB in the MIDDLE of the main database file
 *                      with 0xFF. This is the case with no defined recovery:
 *                      a checksummed WAL can be discarded, a corrupted b-tree
 *                      page cannot. This asks whether Argus NOTICES.
 * `truncate-half`      cut the main database file to half its length, which is
 *                      what a real mid-write disk failure or a killed writer on
 *                      a non-journalled path looks like from the outside.
 *
 * ---------------------------------------------------------------------------
 * WHAT "LOUD" AND "RECOVERABLE" MEAN HERE, DECIDED BEFORE RUNNING
 * ---------------------------------------------------------------------------
 * LOUD means an operator asking the system how it is gets told something is
 * wrong. Concretely: `health.json` carries a non-null `lastError` within
 * OBSERVE_MS, or the watcher exits non-zero, or it writes to stderr. Silence
 * plus a green health file plus a frozen row count is the failure mode this
 * ticket exists to catch, and it is the one #117 already found once.
 *
 * RECOVERABLE WITHOUT HAND INTERVENTION means the archiver resumes archiving
 * NEW messages, on its own, within OBSERVE_MS, with no operator action. Note
 * what that does NOT claim: rows already destroyed are gone, and this scenario
 * does not pretend otherwise. It reports rowsBefore, rowsAfter and rowsAtEnd
 * so the difference between "kept working" and "kept everything" stays visible.
 *
 * No numeric threshold is invented and no verdict is pre-registered, because
 * there is no measurement here to threshold — each outcome is a fact about what
 * the archiver did, reported with the log excerpt that shows it. The ticket
 * asks for exactly that: raw log excerpts for the qualitative recovery checks.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, openSync, closeSync, existsSync, writeSync, statSync, truncateSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , scratchRoot, cliPath, modeArgument] = process.argv;
if (!scratchRoot || !cliPath) {
  throw new Error("usage: corrupt119.ts <scratch-root> <cli-path> [mode,mode,...]");
}
// Plainly typed: `runMode` is hoisted, so the narrowing above does not reach it.
const root: string = scratchRoot;
const cli: string = cliPath;

const OBSERVE_MS = 90_000;
const POLL_MS = 1_000;
const ALL_MODES = ["wal-tail-garbage", "page-garbage", "truncate-half"] as const;
type Mode = (typeof ALL_MODES)[number];

const PAGE_BYTES = 4_096;
/**
 * #119 H3. The main file must be big enough that "half of it, page aligned" is
 * a real b-tree page and not EOF. 16 pages puts the target at page 9 of 16 with
 * seven pages of live data on either side of it, which no rounding can collapse
 * to the header page or past the end.
 */
const MIN_DB_PAGES = 16;
/** Messages appended per seed tick. Only sets how fast the archive fills. */
const SEED_BATCH = 8;
/** Give up seeding rather than run forever if the archiver is not keeping up. */
const SEED_TIMEOUT_MS = 240_000;

const MODES: readonly Mode[] = (() => {
  if (modeArgument === undefined) return ALL_MODES;
  const requested = modeArgument.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  for (const entry of requested) {
    if (!(ALL_MODES as readonly string[]).includes(entry)) throw new Error(`unknown mode: ${entry}`);
  }
  return requested as Mode[];
})();

const resultsPath = join(root, "corruption.jsonl");
function record(entry: Record<string, unknown>): void {
  appendFileSync(resultsPath, `${JSON.stringify(entry)}\n`);
}

interface ArchiveState {
  error: string | null;
  integrity: string | null;
  rows: number | null;
}

function archiveState(archive: string): ArchiveState {
  let database: Database | undefined;
  try {
    database = new Database(archive, { readonly: true, strict: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const rows =
      database.query<{ c: number }, []>("SELECT count(*) AS c FROM archive_messages").get()?.c ?? null;
    let integrity: string | null = null;
    try {
      integrity =
        Object.values(database.query<Record<string, string>, []>("PRAGMA integrity_check").get() ?? {})[0] ??
        null;
    } catch (error) {
      integrity = `integrity_check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { error: null, integrity, rows };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), integrity: null, rows: null };
  } finally {
    database?.close();
  }
}

/**
 * #119 H3. Move committed rows out of the WAL and into the main database file,
 * which is the file every "main-db" corruption mode targets. TRUNCATE also
 * zeroes the WAL, so a later reader cannot silently read an intact copy of the
 * page this scenario is about to damage and mask the whole experiment.
 * Returns SQLite's own (busy, log, checkpointed) triple, recorded verbatim.
 */
function checkpoint(archive: string): Record<string, unknown> {
  // Never CREATE the archive: opening a read-write handle to a path the
  // archiver has not made yet would hand it an empty file it did not build.
  if (!existsSync(archive)) return { ok: false, error: "archive does not exist yet" };
  let database: Database | undefined;
  try {
    database = new Database(archive, { strict: true });
    database.exec("PRAGMA busy_timeout = 10000");
    const row = database.query<Record<string, number>, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return { ok: true, result: row ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
}

/** Sizes and page count, so every corruption records the file it acted on. */
function dbFacts(archive: string): Record<string, unknown> {
  const size = (() => {
    try {
      return statSync(archive).size;
    } catch {
      return null;
    }
  })();
  const walBytes = (() => {
    try {
      return statSync(`${archive}-wal`).size;
    } catch {
      return null;
    }
  })();
  let pageCount: number | null = null;
  let database: Database | undefined;
  try {
    database = new Database(archive, { readonly: true, strict: true });
    pageCount = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? null;
  } catch {
    pageCount = null;
  } finally {
    database?.close();
  }
  return { dbBytes: size, pageCount, walBytes };
}

async function health(repo: string): Promise<Record<string, unknown> | null> {
  try {
    return (await Bun.file(join(repo, ".argus", "eyes", "archiver", "health.json")).json()) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function corrupt(mode: Mode, archive: string): Record<string, unknown> {
  if (mode === "wal-tail-garbage") {
    const wal = `${archive}-wal`;
    const size = statSync(wal).size;
    const length = Math.min(512, size);
    if (length === 0) return { applied: false, reason: "wal is empty", walBytes: size };
    const handle = openSync(wal, "r+");
    try {
      writeSync(handle, Buffer.alloc(length, 0xff), 0, length, size - length);
    } finally {
      closeSync(handle);
    }
    return { applied: true, bytes: length, target: "wal", walBytesBefore: size };
  }
  if (mode === "page-garbage") {
    const facts = dbFacts(archive);
    const size = statSync(archive).size;
    // Middle of the file, page aligned, and never page 1 — clobbering the
    // header would be a different (and much easier to notice) experiment.
    const offset = Math.max(PAGE_BYTES, Math.floor(size / 2 / PAGE_BYTES) * PAGE_BYTES);
    // #119 H3. THE GUARD THAT WAS MISSING. With a one-page file the expression
    // above returns exactly EOF and the write appends a page SQLite never looks
    // at, which is how #117's page-garbage result came to mean nothing while
    // still reporting `applied: true`. Refuse instead, and say so with numbers.
    if (offset + PAGE_BYTES > size) {
      return {
        applied: false,
        ...facts,
        offset,
        reason: "computed offset is not a whole page strictly inside the file; refusing to write past EOF",
        target: "main-db",
      };
    }
    const handle = openSync(archive, "r+");
    try {
      writeSync(handle, Buffer.alloc(PAGE_BYTES, 0xff), 0, PAGE_BYTES, offset);
    } finally {
      closeSync(handle);
    }
    return {
      applied: true,
      bytes: PAGE_BYTES,
      ...facts,
      dbBytesBefore: size,
      offset,
      // 1-based, the way SQLite numbers pages.
      targetPage: offset / PAGE_BYTES + 1,
      target: "main-db",
    };
  }
  const size = statSync(archive).size;
  truncateSync(archive, Math.floor(size / 2));
  return { applied: true, dbBytesBefore: size, dbBytesAfter: Math.floor(size / 2), target: "main-db" };
}

/** Append one codex message to the repo's rollout, so there is always work. */
async function traffic(rollout: string, ordinal: number): Promise<void> {
  await Bun.write(
    rollout,
    `${await Bun.file(rollout).text()}${JSON.stringify({
      timestamp: new Date().toISOString(),
      ordinal,
      type: "response_item",
      payload: {
        type: "message",
        role: ordinal % 2 === 1 ? "user" : "assistant",
        content: [
          {
            type: ordinal % 2 === 1 ? "input_text" : "output_text",
            text: `corrupt117 probe ${ordinal} argus watcher archiver sqlite backlog`,
          },
        ],
      },
    })}\n`,
  );
}

async function runMode(mode: Mode): Promise<void> {
  const base = join(root, mode);
  const home = join(base, "home");
  const repoPath = join(base, "repo");
  const sessions = join(home, ".codex", "sessions", "2026", "08", "28");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  await mkdir(join(home, ".hermes"), { recursive: true });
  await mkdir(join(repoPath, ".argus"), { recursive: true });
  Bun.spawnSync(["/usr/bin/git", "init", "--quiet", repoPath]);
  const repo = await realpath(repoPath);
  await writeFile(join(repo, ".argus", "config.yaml"), "brain:\n  model: argus-chaos-invalid\n");
  await writeFile(
    join(repo, ".argus", "honcho.yaml"),
    "url: http://127.0.0.1:1\nworkspace: argus-chaos-117-corrupt\n",
  );
  const registry = join(base, "argus-repos");
  await writeFile(registry, `${repo}\n`);

  const id = `00000000-0000-0000-1170-00000011700${MODES.indexOf(mode)}`;
  const rollout = join(sessions, `rollout-2026-08-28T00-00-00-${id}.jsonl`);
  await writeFile(
    rollout,
    `${JSON.stringify({
      timestamp: "2026-08-28T00:00:00.000Z",
      type: "session_meta",
      payload: { id, session_id: id, cwd: repo, cli_version: "0.149.0" },
    })}\n`,
  );

  const stderrPath = join(base, "watcher.stderr");
  const watcher = Bun.spawn([process.execPath, cli, "watch", "archiver", "--repo", repo], {
    cwd: repo,
    env: {
      ARGUS_REPOS_FILE: registry,
      // R4: the watcher polls this pid and exits on its own if this driver dies,
      // so no teardown path of this script is load-bearing (src/watch.ts).
      ARGUS_WATCH_OWNER_PID: String(process.pid),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      HERMES_HOME: join(home, ".hermes"),
      HOME: home,
      PATH: Bun.env.PATH ?? "/usr/bin:/bin",
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  const stderrChunks: string[] = [];
  void (async () => {
    for await (const chunk of watcher.stderr as ReadableStream<Uint8Array>) {
      stderrChunks.push(new TextDecoder().decode(chunk));
    }
  })();

  const archive = join(repo, ".argus", "archive.db");
  let ordinal = 1;
  const started = Date.now();
  // #119 H3 SEED PHASE. Fill the archive and checkpoint it, so the corruption
  // below lands on live b-tree pages instead of on an empty header page. This
  // replaces #117's fixed 25 s settle, which was the whole defect.
  let seedTicks = 0;
  let lastCheckpoint: Record<string, unknown> = { ok: false, error: "never ran" };
  let facts = dbFacts(archive);
  while (Date.now() - started < SEED_TIMEOUT_MS) {
    for (let n = 0; n < SEED_BATCH; n += 1) await traffic(rollout, ordinal++);
    await Bun.sleep(POLL_MS);
    seedTicks += 1;
    lastCheckpoint = checkpoint(archive);
    facts = dbFacts(archive);
    const pages = facts.pageCount;
    if (typeof pages === "number" && pages >= MIN_DB_PAGES) break;
  }
  const seed = {
    lastCheckpoint,
    minDbPages: MIN_DB_PAGES,
    reachedMinimum: typeof facts.pageCount === "number" && facts.pageCount >= MIN_DB_PAGES,
    seedMs: Date.now() - started,
    seedTicks,
    stateAtCorruption: facts,
  };

  const before = archiveState(archive);
  const healthBefore = await health(repo);

  let damage: Record<string, unknown>;
  try {
    damage = corrupt(mode, archive);
  } catch (error) {
    damage = { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const corruptedAt = Date.now();
  // #119 H3 CONTROL. Did the damage actually damage anything? Asked of a fresh
  // read-only connection before the archiver has had a chance to react, so a
  // later `ok` cannot be confused with the corruption never having taken.
  const integrityImmediatelyAfterCorruption = archiveState(archive);

  // Keep writing messages the whole time: a "recovered" archiver has to have
  // something to archive, or recovery is indistinguishable from idleness.
  let firstErrorAfterMs: number | null = null;
  let firstRowGrowthAfterMs: number | null = null;
  const rowsAtCorruption = before.rows;
  const timeline: Array<Record<string, unknown>> = [];
  while (Date.now() - corruptedAt < OBSERVE_MS) {
    await traffic(rollout, ordinal++);
    await Bun.sleep(POLL_MS);
    const state = archiveState(archive);
    const now = await health(repo);
    const lastError = (now?.lastError ?? null) as { message?: string } | null;
    if (firstErrorAfterMs === null && (lastError !== null || watcher.killed)) {
      firstErrorAfterMs = Date.now() - corruptedAt;
    }
    if (
      firstRowGrowthAfterMs === null &&
      state.rows !== null &&
      rowsAtCorruption !== null &&
      state.rows > rowsAtCorruption
    ) {
      firstRowGrowthAfterMs = Date.now() - corruptedAt;
    }
    if (timeline.length < 12 || (Date.now() - corruptedAt) % 15_000 < POLL_MS) {
      timeline.push({
        atMs: Date.now() - corruptedAt,
        health: lastError === null ? null : String(lastError.message).slice(0, 160),
        rows: state.rows,
        readError: state.error === null ? null : state.error.slice(0, 120),
      });
    }
  }

  const after = archiveState(archive);
  const healthAfter = await health(repo);
  const watcherAlive = !watcher.killed && watcher.exitCode === null;
  watcher.kill("SIGTERM");
  const exitCode = await watcher.exited;
  const stderr = stderrChunks.join("");
  await Bun.write(stderrPath, stderr);

  record({
    corruption: damage,
    healthAfter,
    healthBefore,
    // #119 H3: the control, and the seed phase that made the damage meaningful.
    integrityImmediatelyAfterCorruption,
    seed,
    stateAtEnd: dbFacts(archive),
    // LOUD: did anything tell an operator? Three independent channels.
    loud: {
      exitedNonZero: exitCode !== 0,
      healthLastErrorAfter: (healthAfter?.lastError ?? null) !== null,
      firstErrorAfterMs,
      stderrLines: stderr.split("\n").filter((line) => line.trim().length > 0).length,
      stderrSample: stderr.split("\n").filter((line) => line.trim().length > 0).slice(0, 6),
    },
    mode,
    observeMs: OBSERVE_MS,
    // RECOVERED: did NEW messages start landing again, with no human involved?
    recoveredUnattended: firstRowGrowthAfterMs !== null,
    firstRowGrowthAfterMs,
    rowsAfterObservation: after.rows,
    rowsAtEndIntegrity: after.integrity,
    rowsBeforeCorruption: before.rows,
    stderrPath,
    timeline,
    watcherAliveAtEnd: watcherAlive,
    watcherExitCode: exitCode,
  });
  const stderrLines = stderr.split("\n").filter((line) => line.trim().length > 0).length;
  const healthLoud = (healthAfter?.lastError ?? null) !== null;
  // All three channels the LOUD definition names, together and separately.
  const loudAnywhere = healthLoud || exitCode !== 0 || stderrLines > 0;
  console.log(
    `${mode}: applied=${damage.applied === true} ` +
      `pagesAtCorruption=${String(seed.stateAtCorruption.pageCount)} ` +
      `targetPage=${String(damage.targetPage ?? "n/a")} ` +
      `controlIntegrity=${String(integrityImmediatelyAfterCorruption.integrity ?? integrityImmediatelyAfterCorruption.error)} ` +
      `loud=${loudAnywhere} (health=${healthLoud} exitNonZero=${exitCode !== 0} stderrLines=${stderrLines}) ` +
      `recovered=${firstRowGrowthAfterMs !== null} ` +
      `rows=${String(before.rows)}->${String(after.rows)}`,
  );
}

record({
  event: "corruption-scenario-start",
  at: new Date().toISOString(),
  minDbPages: MIN_DB_PAGES,
  modes: MODES,
  observeMs: OBSERVE_MS,
  ticket: 119,
});
for (const mode of MODES) await runMode(mode);
record({ event: "corruption-scenario-end", at: new Date().toISOString() });
