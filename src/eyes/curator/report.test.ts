import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyReport, reportDirectory, writeReport } from "./report";

const AT = "2026-08-31T09:30:00.000Z";

async function withRepo(body: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "argus-curator-report-"));
  try {
    await body(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
}

describe("the per-run report (lifted convention: agent/curator.py:490-510)", () => {
  test("a pass writes run.json and REPORT.md under .argus/reports/curator/", async () => {
    await withRepo(async (repo) => {
      const report = emptyReport(AT);
      report.finished_at = AT;
      report.archived.skills.push({
        name: "legacy-deploy-dance",
        from: "/x/legacy-deploy-dance",
        to: "/x/.archive/legacy-deploy-dance",
        reason: "97 days idle",
      });

      const written = await writeReport(repo, report);

      expect(written.directory).toBe(
        join(repo, ".argus/reports/curator/20260831T093000Z"),
      );
      expect(reportDirectory(repo, AT)).toBe(written.directory);
      const runJson = await Bun.file(join(written.directory, "run.json")).json();
      expect(runJson.archived.skills[0].name).toBe("legacy-deploy-dance");
      const markdown = await Bun.file(join(written.directory, "REPORT.md")).text();
      expect(markdown).toContain("legacy-deploy-dance");
      expect(markdown).toContain("97 days idle");
    });
  });

  test("the report names the rollback point the snapshot left behind", async () => {
    await withRepo(async (repo) => {
      const report = emptyReport(AT);
      report.backup = { ok: true, sha: "abc123" };
      const written = await writeReport(repo, report);
      expect(await Bun.file(join(written.directory, "REPORT.md")).text()).toContain(
        "abc123",
      );
    });
  });

  test("a dry run says so, loudly, at the top", async () => {
    await withRepo(async (repo) => {
      const report = emptyReport(AT);
      report.dry_run = true;
      const written = await writeReport(repo, report);
      const markdown = await Bun.file(join(written.directory, "REPORT.md")).text();
      expect(markdown.split("\n").slice(0, 3).join("\n")).toContain("DRY RUN");
    });
  });

  test("a pass that changed nothing still leaves its audit trail", async () => {
    await withRepo(async (repo) => {
      const written = await writeReport(repo, emptyReport(AT));
      const markdown = await Bun.file(join(written.directory, "REPORT.md")).text();
      expect(markdown).toContain("Archived: none");
    });
  });

  test("orphans and rejected proposals are surfaced, never swallowed", async () => {
    await withRepo(async (repo) => {
      const report = emptyReport(AT);
      report.orphans.push({ kind: "index-without-file", slug: "ghost" });
      report.llm.rejected.push({
        what: "consolidation deploy-staging → nowhere",
        reason: "unknown skill: nowhere",
      });
      const written = await writeReport(repo, report);
      const markdown = await Bun.file(join(written.directory, "REPORT.md")).text();
      expect(markdown).toContain("ghost");
      expect(markdown).toContain("unknown skill: nowhere");
    });
  });
});
