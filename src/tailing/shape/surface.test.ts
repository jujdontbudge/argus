/**
 * Is the canary AUDIBLE? (#100)
 *
 * #53 established the standard this file holds to: prove the alarm on the real
 * operator surface — the actual stdout of a real `argus status` subprocess —
 * because a test that only checks an internal counter recreates the very
 * silence the alarm exists to remove. Four silent bugs is the reason.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { recordAudits } from "../../audits/store.ts";
import { ProvenanceFeed } from "../../eyes/source.ts";
import { createClaudeCodeSource } from "../claude-code.ts";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "argus-shape-drift-"));
  roots.push(root);
  const repo = join(root, "repo");
  const claudeDir = join(root, "claude-project");
  const registryPath = join(root, "repos");
  const statusPath = join(root, "supervisor-status.json");
  await Promise.all([mkdir(repo, { recursive: true }), mkdir(claudeDir, { recursive: true })]);
  await Bun.write(registryPath, `${repo}\n`);
  return {
    claudeDir,
    registryPath,
    repo,
    statusPath,
    transcript: join(claudeDir, "session.jsonl"),
  };
}

/** A record shaped exactly as today's real Claude CLI writes one. */
function familiar(extra: Record<string, unknown> = {}, index = 1): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: "confirm deployment" },
    timestamp: "2026-08-26T20:00:00.000Z",
    promptSource: "typed",
    origin: { kind: "human" },
    uuid: `shape-drift-${index}`,
    sessionId: "session-shape-drift",
    cwd: "/tmp/project",
    version: "2.1.246",
    isSidechain: false,
    ...extra,
  };
}

async function ingest(options: Awaited<ReturnType<typeof scratch>>): Promise<void> {
  const source = createClaudeCodeSource({ dir: options.claudeDir });
  const batch = await new ProvenanceFeed(source, options.repo).catchUp();
  await recordAudits(options.repo, "reviewer", batch.audits);
}

async function runStatus(options: Awaited<ReturnType<typeof scratch>>) {
  const child = Bun.spawn([process.execPath, cli, "status"], {
    env: {
      ...Bun.env,
      ARGUS_REPOS_FILE: options.registryPath,
      ARGUS_SUPERVISOR_CONTROL: "disabled",
      ARGUS_SUPERVISOR_STATUS_FILE: options.statusPath,
      HOME: join(options.repo, ".."),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stdout };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("record-shape drift is audible to an operator (#100)", () => {
  test("today's real record shape is silent — so every assertion below is not vacuous", async () => {
    const options = await scratch();
    await Bun.write(options.transcript, `${JSON.stringify(familiar())}\n`);
    await ingest(options);

    const result = await runStatus(options);

    expect(result.stdout).not.toContain("record-shape-drift");
  });

  test("a field the CLI has never written before is named, with a readable reason", async () => {
    const options = await scratch();
    await Bun.write(
      options.transcript,
      `${JSON.stringify(familiar({ attributionHint: { author: "someone" } }))}\n`,
    );
    await ingest(options);

    const result = await runStatus(options);

    expect(result.stdout).toContain("record-shape-drift");
    expect(result.stdout).toContain('"token":"attributionHint"');
    expect(result.stdout).toContain('"severity":"notice"');
    expect(result.stdout).toContain("has never carried");
    // Degraded, not refused: #96's shape. The operator must be able to act.
    expect(result.exitCode).toBe(1);
  });

  test("a value on a field the parser BRANCHES on is decision-bearing, not a notice", async () => {
    const options = await scratch();
    await Bun.write(
      options.transcript,
      `${JSON.stringify(familiar({ origin: { kind: "delegate" } }))}\n`,
    );
    await ingest(options);

    const result = await runStatus(options);

    expect(result.stdout).toContain('"severity":"decision-bearing"');
    expect(result.stdout).toContain('"path":"origin.kind"');
    expect(result.stdout).toContain('"token":"delegate"');
  });

  test("the drifted record is still classified — degrade, never refuse", async () => {
    const options = await scratch();
    await Bun.write(
      options.transcript,
      `${JSON.stringify(familiar({ attributionHint: 1 }))}\n`,
    );
    const source = createClaudeCodeSource({ dir: options.claudeDir });
    const batch = await new ProvenanceFeed(source, options.repo).catchUp();

    // A hard refusal on an unknown field would take the always-on eyes down
    // over a cosmetic CLI change; the record must still produce its record.
    expect(batch.records.map(({ text }) => text)).toEqual(["confirm deployment"]);
    expect(batch.audits.some(({ type }) => type === "record-shape-drift")).toBe(true);
  });

  test("one alarm per unknown FACT, not one per record carrying it", async () => {
    const options = await scratch();
    await Bun.write(
      options.transcript,
      `${Array.from({ length: 50 }, (_, index) =>
        JSON.stringify(familiar({ attributionHint: index }, index + 1)),
      ).join("\n")}\n`,
    );
    await ingest(options);

    const result = await runStatus(options);

    expect(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("  record-shape-drift  ")).length,
    ).toBe(1);
  });
});
