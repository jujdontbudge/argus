/**
 * Byte-offset incremental line reader — the primitive under transcript
 * cursors. Consumes only complete (newline-terminated) lines so a cursor
 * never points into the middle of a record, and reports truncation so the
 * tailer can restart a rotated file from zero.
 */
import { open } from "node:fs/promises";

export interface ReadResult {
  /** Complete lines (without their newline), in file order. */
  lines: string[];
  /** Byte offset just past the last consumed newline; the next cursor. */
  offset: number;
  /** True when the file is now smaller than the given offset (rotation). */
  truncated: boolean;
}

export async function readNewLines(file: string, offset: number): Promise<ReadResult> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    // A listed file can vanish between discovery and read (rotation window).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], offset, truncated: false };
    }
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const truncated = size < offset;
    if (truncated) offset = 0;
    const length = size - offset;
    if (length <= 0) {
      return { lines: [], offset, truncated };
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      return { lines: [], offset, truncated };
    }
    const consumed = buffer.subarray(0, lastNewline + 1);
    return {
      lines: consumed.toString("utf8").split("\n").slice(0, -1),
      offset: offset + lastNewline + 1,
      truncated,
    };
  } finally {
    await handle.close();
  }
}
