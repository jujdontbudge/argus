import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewLines } from "./line-reader";

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "argus-tail-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("readNewLines", () => {
  test("a partial trailing line is left unconsumed until its newline lands", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "t.jsonl");
      await writeFile(file, '{"a":1}\n{"b":');

      const first = await readNewLines(file, 0);
      expect(first.lines).toEqual(['{"a":1}']);
      expect(first.offset).toBe(8);

      await writeFile(file, '{"a":1}\n{"b":2}\n');
      const second = await readNewLines(file, first.offset);
      expect(second.lines).toEqual(['{"b":2}']);
      expect(second.offset).toBe(16);
    });
  });

  test("a file smaller than the cursor reports truncation and rereads from zero", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "t.jsonl");
      await writeFile(file, '{"a":1}\n{"b":2}\n');
      const before = await readNewLines(file, 0);

      // Rotation: the file was replaced by a shorter successor.
      await writeFile(file, '{"c":3}\n');
      const after = await readNewLines(file, before.offset);

      expect(after.truncated).toBe(true);
      expect(after.lines).toEqual(['{"c":3}']);
      expect(after.offset).toBe(8);
    });
  });

  test("offsets count bytes, not characters (multi-byte UTF-8)", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "t.jsonl");
      await writeFile(file, "héllo\n"); // é is 2 bytes in UTF-8

      const first = await readNewLines(file, 0);
      expect(first.lines).toEqual(["héllo"]);
      expect(first.offset).toBe(7);

      await writeFile(file, "héllo\nnext\n");
      const second = await readNewLines(file, first.offset);
      expect(second.lines).toEqual(["next"]);
    });
  });

  test("a missing file yields no lines and keeps the cursor", async () => {
    await withDir(async (dir) => {
      const result = await readNewLines(join(dir, "gone.jsonl"), 5);

      expect(result).toEqual({ lines: [], offset: 5, truncated: false });
    });
  });

  test("reads complete newline-terminated lines from offset 0", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "t.jsonl");
      await writeFile(file, '{"a":1}\n{"b":2}\n');

      const result = await readNewLines(file, 0);

      expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
      expect(result.offset).toBe(16); // consumed through the final newline
      expect(result.truncated).toBe(false);
    });
  });
});
