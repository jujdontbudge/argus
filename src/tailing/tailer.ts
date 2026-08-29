/**
 * Cursor-based transcript tailer (SPEC §5). One Tailer per source; callers
 * either poll with catchUp() or subscribe with watch(). Cursors (byte offset
 * per file) are the crash-recovery contract: persist cursors() after
 * processing a batch, hand them to the next Tailer, and no message is lost
 * or duplicated across a watcher death (§13 scenario 6).
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { SourceParser, TailEvent, TranscriptSource } from "./events";
import { readNewLines } from "./line-reader";

/** Byte offset of the next unread line, per transcript file path. */
export type CursorMap = Record<string, number>;

export interface TailerOptions {
  /** Cursors persisted by a previous run; omitted files start at zero. */
  cursors?: CursorMap;
}

export interface WatchOptions {
  /** Poll interval, ms. Polling is the correctness path; fs events only accelerate it. */
  pollMs?: number;
  /** Called when a poll fails; without it the error propagates (loud, §13.5 spirit). */
  onError?: (error: unknown) => void;
}

export class Tailer {
  private readonly parsers = new Map<string, SourceParser>();
  private readonly offsets: Map<string, number>;

  constructor(
    private readonly source: TranscriptSource,
    options: TailerOptions = {},
  ) {
    this.offsets = new Map(Object.entries(options.cursors ?? {}));
  }

  /**
   * Read everything new (all files, cursor → EOF, complete lines only) and
   * return the events in deterministic order: files sorted by path, lines in
   * byte order. Also the backfill path after a restart.
   */
  async catchUp(): Promise<TailEvent[]> {
    const events: TailEvent[] = [];
    const files = [...(await this.source.listFiles())].sort();
    for (const file of files) {
      const key = this.source.fileKey?.(file) ?? file;
      const result = this.source.readNewLines
        ? await this.source.readNewLines(file, this.offsets.get(key) ?? 0)
        : await readNewLines(file, this.offsets.get(key) ?? 0);
      if (result.truncated) {
        // Rotation: a new file now lives at this path — parser state resets.
        this.parsers.delete(key);
        events.push({ type: "lifecycle", kind: "file-truncated", file });
      }
      // Where this read actually STARTED. After a rotation `readNewLines` has
      // already reset to zero and is handing back the new file from line one,
      // so there is nothing before it to prime from — and priming there would
      // swallow the successor session's own session-meta, which is exactly what
      // the rotation tests in tailer.test.ts and codex.test.ts pin.
      const readFrom = result.truncated ? 0 : this.offsets.get(key) ?? 0;
      if (result.lines.length > 0) {
        let parser = this.parsers.get(key);
        if (!parser) {
          parser = this.source.createParser(file);
          this.parsers.set(key, parser);
          if (readFrom > 0) await this.prime(parser, file, readFrom);
        }
        for (const line of result.lines) {
          events.push(...parser.parseLine(line));
        }
      }
      this.offsets.set(key, result.offset);
    }
    return events;
  }

  /**
   * Replay the bytes BEFORE a resumed cursor through a fresh parser, discarding
   * every event, so the parser reaches the state it would have been in had it
   * read the file from the start.
   *
   * Parsers are stateful about things that appear ONCE, at the top of a file.
   * `CodexParser` latches `sessionId` and `cwd` from the rollout's single
   * `session_meta` line, and every later branch of its `parseRecord` is gated on
   * `this.sessionId`; `sessionsForRepo` (src/eyes/source.ts) builds its
   * accepted-session set from `session-meta` events for the same reason. A
   * parser constructed at a persisted cursor never sees that line, so it emits
   * nothing, forever, and reports a clean empty batch while doing it.
   *
   * #117 measured that live: a SIGKILLed archiver's replacement restarted
   * inside budget, took the watch lease, reported `backlog: 0` and no error,
   * and never archived another message. The cursor contract in this file's own
   * docblock — "persist cursors, hand them to the next Tailer, and no message
   * is lost" — was not being honoured, because the cursor alone was never
   * enough to reconstruct a parser.
   *
   * COST. This is one extra read of the prior region, once per file per Tailer,
   * and only for a file that both has a non-zero cursor and has new bytes
   * waiting. It is byte-for-byte the read a cold start already performs, so it
   * adds no peak the first poll of a fresh watcher does not already reach, and
   * an idle poll still costs nothing. It emits nothing, so it cannot duplicate
   * a message that the cursor already accounted for.
   */
  private async prime(
    parser: SourceParser,
    file: string,
    upTo: number,
  ): Promise<void> {
    if (this.source.primeParser) {
      await this.source.primeParser(parser, file, upTo);
      return;
    }
    const prior = this.source.readNewLines
      ? await this.source.readNewLines(file, 0)
      : await readNewLines(file, 0);
    let consumed = 0;
    for (const line of prior.lines) {
      if (consumed >= upTo) break;
      consumed += Buffer.byteLength(line, "utf8") + 1;
      parser.parseLine(line);
    }
  }

  /** Snapshot for persistence; valid input for a future Tailer's `cursors`. */
  cursors(): CursorMap {
    return Object.fromEntries(this.offsets);
  }

  /** Persisted key corresponding to an event's physical source file. */
  cursorKey(file: string): string {
    return this.source.fileKey?.(file) ?? file;
  }

  /**
   * Continuously deliver new events. Returns an async stop function that
   * resolves once the in-flight poll (if any) has completed — a batch in
   * flight when stop is called is still delivered, because cursors must
   * never advance past an undelivered event. Polling drives correctness
   * (fs.watch on the source's watch paths merely shortens the latency);
   * ticks never overlap.
   */
  watch(
    listener: (events: TailEvent[]) => void,
    options: WatchOptions = {},
  ): () => Promise<void> {
    const pollMs = options.pollMs ?? 250;
    let stopped = false;
    let current: Promise<void> | null = null;
    let runAgain = false;

    const run = async (): Promise<void> => {
      try {
        const events = await this.catchUp();
        if (events.length > 0) listener(events);
      } catch (error) {
        if (options.onError) options.onError(error);
        else throw error;
      } finally {
        current = null;
      }
      if (runAgain && !stopped) {
        runAgain = false;
        tick();
      }
    };

    const tick = (): void => {
      if (stopped) return;
      if (current) {
        runAgain = true;
        return;
      }
      current = run();
    };

    const interval = setInterval(tick, pollMs);
    const watchers: FSWatcher[] = [];
    for (const path of this.source.watchPaths()) {
      try {
        const watcher = fsWatch(path, tick);
        watcher.on("error", () => {}); // a vanished dir degrades to pure polling
        watchers.push(watcher);
      } catch {
        // Missing directory: polling still covers it if it appears later.
      }
    }
    tick();

    return async () => {
      stopped = true;
      clearInterval(interval);
      for (const watcher of watchers) watcher.close();
      await current;
    };
  }
}
