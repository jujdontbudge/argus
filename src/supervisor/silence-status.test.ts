import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openArchiver } from "../eyes/archiver/index.ts";
import { appendSessionRow, registryPaths } from "../provenance";
import { SILENT_DEPLOYMENT_MS } from "./silence.ts";

/**
 * Ticket #96, half 2, from the OUTSIDE: what an operator actually sees.
 *
 * #85's bar is the one this has to clear — an exit code AND a reason good
 * enough to act on. "Degraded" with no reason is not enough, so these tests
 * read the real `argus status` output of a real CLI process, with a live
 * archiver pid and a real archive database, and assert on the words.
 */
const roots: string[] = [];
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

interface Scratch {
  registryPath: string;
  repo: string;
  root: string;
  statusPath: string;
}

async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), "argus-silence-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const registryPath = join(root, "repos");
  const statusPath = join(root, "supervisor-status.json");
  await Bun.write(registryPath, `${repo}\n`);
  return { registryPath, repo, root, statusPath };
}

/** A supervisor status file and health report for a LIVE archiver. */
async function liveArchiver(options: Scratch, pid = process.pid): Promise<void> {
  await Bun.write(
    options.statusPath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      watchers: [{ eye: "archiver", pid, repo: options.repo, state: "running" }],
    }),
  );
  await Bun.write(
    join(options.repo, ".argus", "eyes", "archiver", "health.json"),
    JSON.stringify({
      backlog: 0,
      eye: "archiver",
      lastError: null,
      lastSuccess: new Date().toISOString(),
      pid,
      repo: options.repo,
      updatedAt: new Date().toISOString(),
    }),
  );
}

async function deploymentRow(
  repo: string,
  sessionId: string,
  agedMs: number,
): Promise<void> {
  await appendSessionRow(registryPaths(repo).sessionsFile, {
    agent: "claude",
    dispatchPrompt: "You are working ticket #96.",
    sessionId,
    ticket: "96",
    ts: new Date(Date.now() - agedMs).toISOString(),
  });
}

/** One archived message for `sessionId`, through the production schema. */
async function archiveMessage(repo: string, sessionId: string): Promise<void> {
  await openArchiver(repo);
  const database = new Database(join(repo, ".argus", "archive.db"), { strict: true });
  database
    .query(
      `INSERT INTO archive_messages (
         ingest_key, session_id, agent, role, provenance, provenance_via,
         ts, ticket, source_file, source_uuid, content
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `uuid:${sessionId}:1`,
      sessionId,
      "claude",
      "user",
      "hermes",
      "dispatch",
      new Date().toISOString(),
      "96",
      "/transcript.jsonl",
      "1",
      "You are working ticket #96.",
    );
  database.close();
}

async function runStatus(
  options: Scratch,
): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn([process.execPath, cli, "status"], {
    env: {
      ...Bun.env,
      ARGUS_REPOS_FILE: options.registryPath,
      ARGUS_SUPERVISOR_CONTROL: "disabled",
      ARGUS_SUPERVISOR_STATUS_FILE: options.statusPath,
      HOME: options.root,
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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("argus status: a deployment that has archived nothing", () => {
  test("is degraded, with a reason and a non-zero exit", async () => {
    const options = await scratch();
    await liveArchiver(options);
    await deploymentRow(options.repo, "session-silent", SILENT_DEPLOYMENT_MS + 60_000);
    const { exitCode, stdout } = await runStatus(options);
    expect(stdout).toContain("SILENT DEPLOYMENTS");
    expect(stdout).toContain("session-silent");
    expect(stdout).toContain("degraded");
    expect(stdout).toContain("archived 0 messages");
    // The archiver itself is healthy — the degradation is the deployment's,
    // and the output must not blame the eye for it.
    expect(stdout).toMatch(/archiver +running/);
    expect(exitCode).toBe(1);
  }, 30_000);

  test("clears once one message from that session is archived", async () => {
    const options = await scratch();
    await liveArchiver(options);
    await deploymentRow(options.repo, "session-loud", SILENT_DEPLOYMENT_MS + 60_000);
    await archiveMessage(options.repo, "session-loud");
    const { exitCode, stdout } = await runStatus(options);
    expect(stdout).not.toContain("SILENT DEPLOYMENTS");
    expect(exitCode).toBe(0);
  }, 30_000);

  test("says nothing while the deployment is younger than the threshold", async () => {
    const options = await scratch();
    await liveArchiver(options);
    await deploymentRow(options.repo, "session-young", 1_000);
    const { exitCode, stdout } = await runStatus(options);
    expect(stdout).not.toContain("SILENT DEPLOYMENTS");
    expect(exitCode).toBe(0);
  }, 30_000);

  test("says nothing when no archiver is running for the repo", async () => {
    const options = await scratch();
    await deploymentRow(options.repo, "session-unwatched", SILENT_DEPLOYMENT_MS + 60_000);
    const { exitCode, stdout } = await runStatus(options);
    expect(stdout).not.toContain("SILENT DEPLOYMENTS");
    expect(exitCode).toBe(0);
  }, 30_000);
});
