/**
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
import { appendFileSync, openSync, closeSync, writeSync, statSync, truncateSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , scratchRoot, cliPath] = process.argv;
if (!scratchRoot || !cliPath) throw new Error("usage: corrupt117.ts <scratch-root> <cli-path>");
// Plainly typed: `runMode` is hoisted, so the narrowing above does not reach it.
const root: string = scratchRoot;
const cli: string = cliPath;

const OBSERVE_MS = 90_000;
const SETTLE_MS = 25_000;
const POLL_MS = 1_000;
const MODES = ["wal-tail-garbage", "page-garbage", "truncate-half"] as const;
type Mode = (typeof MODES)[number];

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
    const size = statSync(archive).size;
    // Middle of the file, page aligned, and never page 1 — clobbering the
    // header would be a different (and much easier to notice) experiment.
    const offset = Math.max(4096, Math.floor(size / 2 / 4096) * 4096);
    const handle = openSync(archive, "r+");
    try {
      writeSync(handle, Buffer.alloc(4096, 0xff), 0, 4096, offset);
    } finally {
      closeSync(handle);
    }
    return { applied: true, bytes: 4096, dbBytesBefore: size, offset, target: "main-db" };
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
  // Warm up: traffic flowing and rows landing before anything is broken.
  while (Date.now() - started < SETTLE_MS) {
    await traffic(rollout, ordinal++);
    await Bun.sleep(POLL_MS);
  }
  const before = archiveState(archive);
  const healthBefore = await health(repo);

  let damage: Record<string, unknown>;
  try {
    damage = corrupt(mode, archive);
  } catch (error) {
    damage = { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const corruptedAt = Date.now();

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
  console.log(`${mode}: loud=${firstErrorAfterMs !== null} recovered=${firstRowGrowthAfterMs !== null}`);
}

record({ event: "corruption-scenario-start", at: new Date().toISOString(), modes: MODES, observeMs: OBSERVE_MS });
for (const mode of MODES) await runMode(mode);
record({ event: "corruption-scenario-end", at: new Date().toISOString() });
