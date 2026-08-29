import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDigestUpdate,
  digestFileName,
  listDigests,
  MAX_DIGEST_BYTES,
  readDigest,
  updateIndex,
  type DigestSeed,
  type IndexEntry,
} from "./outputs";

const SEED: DigestSeed = {
  agent: "claude",
  ticket: "42",
  startedBy: "hermes",
};

async function withSessionsDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-digest-outputs-"));
  try {
    await body(join(root, ".argus/sessions"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("digest file naming (SPEC §5.4)", () => {
  test("a ticketed session digests to <ticket>-<id>.md", () => {
    expect(digestFileName("42", "sess-1")).toBe("42-sess-1.md");
  });

  test("a ticketless session digests to adhoc-<id>.md", () => {
    expect(digestFileName(undefined, "sess-1")).toBe("adhoc-sess-1.md");
  });
});

describe("the per-session running digest file", () => {
  test("first update creates the file: frontmatter + narrative body", async () => {
    await withSessionsDir(async (dir) => {
      await applyDigestUpdate(dir, "42-sess-1.md", SEED, {
        status: "running",
        narrative: { ts: "2026-08-24T12:01:00.000Z", text: "Started on the tailer fix." },
      });
      const written = await Bun.file(join(dir, "42-sess-1.md")).text();
      expect(written).toBe(
        [
          "---",
          "agent: claude",
          "ticket: 42",
          "status: running",
          "started_by: hermes",
          "johan_touched: false",
          "---",
          "",
          "## 2026-08-24T12:01:00.000Z",
          "",
          "Started on the tailer fix.",
          "",
        ].join("\n"),
      );
    });
  });

  test("an adhoc digest writes ticket: null", async () => {
    await withSessionsDir(async (dir) => {
      await applyDigestUpdate(
        dir,
        "adhoc-sess-2.md",
        { agent: "codex", startedBy: "johan" },
        { status: "running" },
      );
      const written = await Bun.file(join(dir, "adhoc-sess-2.md")).text();
      expect(written).toContain("ticket: null");
      expect(written).toContain("started_by: johan");
    });
  });

  test("status flips patch frontmatter in place; the body keeps appending", async () => {
    await withSessionsDir(async (dir) => {
      const file = "42-sess-1.md";
      await applyDigestUpdate(dir, file, SEED, {
        status: "running",
        narrative: { ts: "2026-08-24T12:01:00.000Z", text: "Working." },
      });
      await applyDigestUpdate(dir, file, SEED, {
        status: "blocked",
        narrative: { ts: "2026-08-24T12:03:00.000Z", text: "Waiting on the API key." },
      });
      await applyDigestUpdate(dir, file, SEED, { status: "done" });
      await applyDigestUpdate(dir, file, SEED, { status: "dead" });

      const written = await Bun.file(join(dir, file)).text();
      expect(written).toContain("status: dead");
      expect(written.match(/^status:/gm)).toHaveLength(1);
      expect(written.indexOf("Working.")).toBeLessThan(
        written.indexOf("Waiting on the API key."),
      );
      expect(written).toContain("agent: claude");
      expect(written).toContain("ticket: 42");
    });
  });

  test("johan_touched is sticky: once true, later updates never lower it", async () => {
    await withSessionsDir(async (dir) => {
      const file = "42-sess-1.md";
      await applyDigestUpdate(dir, file, SEED, { johanTouched: true });
      const applied = await applyDigestUpdate(dir, file, SEED, {
        status: "running",
        johanTouched: false,
      });
      expect(applied.johanTouched).toBe(true);
      expect(await Bun.file(join(dir, file)).text()).toContain(
        "johan_touched: true",
      );
    });
  });

  test("dead is terminal: a later brain judgment cannot resurrect the session", async () => {
    await withSessionsDir(async (dir) => {
      const file = "42-sess-1.md";
      await applyDigestUpdate(dir, file, SEED, { status: "dead" });
      const applied = await applyDigestUpdate(dir, file, SEED, { status: "running" });
      expect(applied.status).toBe("dead");
      expect(await Bun.file(join(dir, file)).text()).toContain("status: dead");
    });
  });

  test("a patch with nothing new leaves the file byte-identical", async () => {
    await withSessionsDir(async (dir) => {
      const file = "42-sess-1.md";
      await applyDigestUpdate(dir, file, SEED, { status: "blocked" });
      const before = await Bun.file(join(dir, file)).text();
      await applyDigestUpdate(dir, file, SEED, { status: "blocked" });
      expect(await Bun.file(join(dir, file)).text()).toBe(before);
    });
  });

  test("oversized input is refused from metadata before any full-file read", async () => {
    await withSessionsDir(async (dir) => {
      const path = join(dir, "adhoc-corrupt.md");
      await mkdir(dir, { recursive: true });
      await writeFile(path, "---\n");
      await truncate(path, MAX_DIGEST_BYTES + 1);

      await expect(
        applyDigestUpdate(dir, "adhoc-corrupt.md", SEED, { status: "done" }),
      ).rejects.toThrow(/digest.*exceeds/i);
      await expect(readDigest(dir, "adhoc-corrupt.md")).rejects.toThrow(
        /digest.*exceeds/i,
      );
    });
  });

  test("repeated narratives compact under the hard byte ceiling", async () => {
    await withSessionsDir(async (dir) => {
      const file = "42-bounded.md";
      for (let index = 0; index < 20; index += 1) {
        await applyDigestUpdate(dir, file, SEED, {
          narrative: {
            ts: `2026-08-29T20:${String(index).padStart(2, "0")}:00.000Z`,
            text: `${index}:${"x".repeat(MAX_DIGEST_BYTES / 4)}`,
          },
        });
      }
      const path = join(dir, file);
      expect((await stat(path)).size).toBeLessThanOrEqual(MAX_DIGEST_BYTES);
      const text = await Bun.file(path).text();
      expect(text).toContain("19:");
      expect(text).toMatch(/older digest narrative truncated/i);
    });
  });

  test("listing refuses a set whose bounded files exceed the aggregate budget", async () => {
    await withSessionsDir(async (dir) => {
      for (let index = 0; index < 80; index += 1) {
        await applyDigestUpdate(dir, `adhoc-${index}.md`, SEED, {
          narrative: {
            ts: "2026-08-29T20:00:00.000Z",
            text: "x".repeat(MAX_DIGEST_BYTES / 4),
          },
        });
      }
      await expect(listDigests(dir)).rejects.toThrow(/aggregate.*budget/i);
    });
  });
});

function indexEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    file: "42-sess-1.md",
    agent: "claude",
    ticket: "42",
    status: "running",
    startedBy: "hermes",
    johanTouched: false,
    ...overrides,
  };
}

const indexLines = async (dir: string): Promise<string[]> =>
  (await Bun.file(join(dir, "INDEX.md")).text())
    .split("\n")
    .filter((line) => line.startsWith("- "));

describe("INDEX.md — one line per session (SPEC §5.4)", () => {
  test("a session's first update appends its line", async () => {
    await withSessionsDir(async (dir) => {
      await updateIndex(dir, indexEntry({ summary: "started on the tailer fix" }));
      const lines = await indexLines(dir);
      expect(lines).toEqual([
        "- 42-sess-1.md — agent=claude ticket=42 status=running started_by=hermes johan_touched=false — started on the tailer fix",
      ]);
    });
  });

  test("re-updating a session rewrites its one line — no duplicates", async () => {
    await withSessionsDir(async (dir) => {
      await updateIndex(dir, indexEntry({ summary: "working" }));
      await updateIndex(dir, indexEntry({ status: "done", summary: "shipped it" }));
      const lines = await indexLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("status=done");
      expect(lines[0]).toContain("— shipped it");
    });
  });

  test("a status-only update preserves the existing summary", async () => {
    await withSessionsDir(async (dir) => {
      await updateIndex(dir, indexEntry({ summary: "working on the fix" }));
      await updateIndex(dir, indexEntry({ status: "blocked" }));
      const lines = await indexLines(dir);
      expect(lines[0]).toContain("status=blocked");
      expect(lines[0]).toContain("— working on the fix");
    });
  });

  test("an adhoc session renders ticket=null", async () => {
    await withSessionsDir(async (dir) => {
      const { ticket: _ticket, ...adhoc } = indexEntry({ file: "adhoc-sess-9.md" });
      await updateIndex(dir, adhoc);
      expect((await indexLines(dir))[0]).toContain("ticket=null");
    });
  });

  test("concurrent updates lose no lines and duplicate none", async () => {
    await withSessionsDir(async (dir) => {
      const sessions = Array.from({ length: 24 }, (_, i) => `sess-${i}`);
      // Every session raced twice (create + update) across one Promise.all:
      // without the INDEX lock the read-modify-write races drop lines.
      await Promise.all(
        sessions.flatMap((id) => [
          updateIndex(dir, indexEntry({ file: `42-${id}.md`, summary: "started" })),
          updateIndex(dir, indexEntry({ file: `42-${id}.md`, status: "done" })),
        ]),
      );
      const lines = await indexLines(dir);
      expect(lines).toHaveLength(sessions.length);
      for (const id of sessions) {
        expect(
          lines.filter((line) => line.includes(`42-${id}.md `)),
        ).toHaveLength(1);
      }
    });
  });
});
