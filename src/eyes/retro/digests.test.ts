import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDigestUpdate, listDigests, readDigest } from "../digest/outputs";

async function withSessions(body: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argus-retro-digests-"));
  try {
    await body(join(root, "sessions"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("the digest signal the Retro eye reads (SPEC §5.4 → §5.5)", () => {
  test("a ticketless digest reads back with its session id and narrative", async () => {
    await withSessions(async (dir) => {
      await applyDigestUpdate(
        dir,
        "adhoc-sess-rogue.md",
        { agent: "claude", startedBy: "johan" },
        {
          status: "done",
          narrative: { ts: "2026-08-24T12:00:00Z", text: "Implemented the widget." },
        },
      );

      const digest = await readDigest(dir, "adhoc-sess-rogue.md");

      expect(digest).not.toBeNull();
      expect(digest!.sessionId).toBe("sess-rogue");
      expect(digest!.frontmatter.ticket).toBeUndefined();
      expect(digest!.frontmatter.agent).toBe("claude");
      expect(digest!.frontmatter.status).toBe("done");
      expect(digest!.body).toContain("Implemented the widget.");
    });
  });

  test("a ticketed digest reports the ticket that covers it", async () => {
    await withSessions(async (dir) => {
      await applyDigestUpdate(
        dir,
        "7-sess-batch.md",
        { agent: "codex", ticket: "7", startedBy: "hermes" },
        { status: "running" },
      );

      const digest = await readDigest(dir, "7-sess-batch.md");

      expect(digest!.sessionId).toBe("sess-batch");
      expect(digest!.frontmatter.ticket).toBe("7");
    });
  });

  test("session ids containing dashes survive the file-name round trip", async () => {
    await withSessions(async (dir) => {
      await applyDigestUpdate(
        dir,
        "adhoc-9f2b-4c1d-8a77.md",
        { agent: "codex", startedBy: "johan" },
        { status: "running" },
      );
      expect((await readDigest(dir, "adhoc-9f2b-4c1d-8a77.md"))!.sessionId).toBe(
        "9f2b-4c1d-8a77",
      );
    });
  });

  test("listDigests returns every session digest and never INDEX.md", async () => {
    await withSessions(async (dir) => {
      await applyDigestUpdate(
        dir,
        "adhoc-a.md",
        { agent: "claude", startedBy: "johan" },
        { status: "running" },
      );
      await applyDigestUpdate(
        dir,
        "7-b.md",
        { agent: "codex", ticket: "7", startedBy: "hermes" },
        { status: "running" },
      );
      await Bun.write(join(dir, "INDEX.md"), "# Session index\n- adhoc-a.md — x\n");

      const digests = await listDigests(dir);

      expect(digests.map((digest) => digest.fileName).sort()).toEqual([
        "7-b.md",
        "adhoc-a.md",
      ]);
    });
  });

  test("a missing digest, and a missing sessions directory, read as nothing", async () => {
    await withSessions(async (dir) => {
      expect(await readDigest(dir, "adhoc-nope.md")).toBeNull();
      expect(await listDigests(dir)).toEqual([]);
    });
  });
});
