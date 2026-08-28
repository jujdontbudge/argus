import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepoTranscriptSource } from "../eyes/source";
import { createCodexSource } from "./codex";
import type { TailEvent } from "./events";
import { Tailer } from "./tailer";

/**
 * Found live by #117's chaos run, not by reasoning about the code.
 *
 * A watcher was SIGKILLed at minute 2 of a 7-minute run. The supervisor
 * restarted it inside its budget, the replacement took the watch lease, and
 * `health.json` reported `backlog: 0` and no error for the remaining four and a
 * half minutes — while the archive stayed frozen at 4,149 rows and 130 of 405
 * sentinel messages. The bystander repo, never killed, archived all 405.
 *
 * The cause is here rather than in the supervisor. A Codex rollout carries its
 * `session_meta` once, as its first line. `CodexParser` latches `sessionId` and
 * `cwd` from that line, and every later branch of `parseRecord` is gated on
 * `this.sessionId` being set. A parser created for a file the Tailer is
 * RESUMING starts at the persisted cursor, never sees line one, and therefore
 * emits nothing at all — forever, for that file. `sessionsForRepo`'s accepted-
 * session set fails the same way for the same reason.
 *
 * Nothing about this needs a SIGKILL. Every ordinary watcher restart takes the
 * same path: the 512 MiB RSS ceiling exit (src/watch.ts), a machine reboot, a
 * re-run of `argus up`. The chaos run is only what made it observable, because
 * it is the first run in this repo to restart a watcher and then check whether
 * messages still arrived.
 */
describe("resuming a tailer from a persisted cursor", () => {
  const roots: string[] = [];

  async function rollout(): Promise<{ codexHome: string; file: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "argus-resume-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    const sessions = join(codexHome, "sessions", "2026", "08", "28");
    await mkdir(sessions, { recursive: true });
    const cwd = join(root, "repo");
    await mkdir(join(cwd, ".git"), { recursive: true });
    const id = "00000000-0000-0000-1170-000000117000";
    const file = join(sessions, `rollout-2026-08-28T00-00-00-${id}.jsonl`);
    await writeFile(
      file,
      `${JSON.stringify({
        timestamp: "2026-08-28T00:00:00.000Z",
        type: "session_meta",
        payload: { id, session_id: id, cwd, cli_version: "0.149.0" },
      })}\n`,
    );
    return { codexHome, file, root };
  }

  async function append(file: string, ordinal: number): Promise<void> {
    await appendFile(
      file,
      `${JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 7, 28, 0, 0, ordinal)).toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `resume probe ${ordinal}` }],
        },
      })}\n`,
    );
  }

  function texts(events: readonly TailEvent[]): string[] {
    return events
      .filter((event): event is Extract<TailEvent, { type: "message" }> => event.type === "message")
      .map(({ text }) => text);
  }

  test("a codex rollout resumed past its session_meta still yields messages", async () => {
    const { codexHome, file } = await rollout();
    await append(file, 1);

    const first = new Tailer(createCodexSource({ codexHome }));
    expect(texts(await first.catchUp())).toEqual(["resume probe 1"]);
    const cursors = first.cursors();
    expect(Object.values(cursors).every((offset) => offset > 0)).toBe(true);

    // The watcher dies here. A NEW Tailer, a NEW parser, the persisted cursor:
    // exactly what the supervisor's replacement watcher constructs.
    await append(file, 2);
    const resumed = new Tailer(createCodexSource({ codexHome }), { cursors });

    expect(texts(await resumed.catchUp())).toEqual(["resume probe 2"]);
  });

  test("a repo-scoped source still attributes its own sessions after a resume", async () => {
    const { codexHome, file, root } = await rollout();
    const repo = join(root, "repo");
    await mkdir(join(repo, ".argus"), { recursive: true });
    await writeFile(
      join(repo, ".argus", "honcho.yaml"),
      "url: http://127.0.0.1:1\nworkspace: argus-resume-117\n",
    );
    const env = { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: codexHome, HERMES_HOME: join(root, "hermes"), HOME: root };
    await append(file, 1);
    const first = new Tailer(await createRepoTranscriptSource(repo, env));
    expect(texts(await first.catchUp())).toEqual(["resume probe 1"]);

    await append(file, 2);
    const resumed = new Tailer(await createRepoTranscriptSource(repo, env), {
      cursors: first.cursors(),
    });

    // This is the path every eye actually runs. `sessionsForRepo` accepts a
    // session only once it has seen a session-meta naming this repo, and a
    // resumed parser never re-reads the line that carries it. Priming restores
    // the accepted set WITHOUT re-emitting the event, which is the distinction
    // that keeps a restart from replaying already-archived messages.
    expect(texts(await resumed.catchUp())).toEqual(["resume probe 2"]);
  });

  test("resuming replays no message that was already delivered", async () => {
    const { codexHome, file } = await rollout();
    for (const ordinal of [1, 2, 3]) await append(file, ordinal);
    const first = new Tailer(createCodexSource({ codexHome }));
    expect(texts(await first.catchUp())).toEqual([
      "resume probe 1",
      "resume probe 2",
      "resume probe 3",
    ]);

    await append(file, 4);
    const resumed = new Tailer(createCodexSource({ codexHome }), { cursors: first.cursors() });

    // The whole point of the cursor. A fix that re-primes the parser by
    // re-reading the file must not turn a restart into a duplicate storm.
    expect(texts(await resumed.catchUp())).toEqual(["resume probe 4"]);
  });

  test("a resumed tailer with nothing new emits nothing", async () => {
    const { codexHome, file } = await rollout();
    await append(file, 1);
    const first = new Tailer(createCodexSource({ codexHome }));
    await first.catchUp();

    const resumed = new Tailer(createCodexSource({ codexHome }), { cursors: first.cursors() });

    // Priming must be driven by there being new bytes to read, not by parser
    // construction: an idle poll must stay free.
    expect(await resumed.catchUp()).toEqual([]);
  });

  test("roots are cleaned up", async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });
});
