import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDigestUpdate,
  digestFileName,
  type DigestSeed,
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
});
