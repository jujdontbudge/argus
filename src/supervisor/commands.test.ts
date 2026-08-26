import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProvenanceFeed } from "../eyes/source.ts";
import { createClaudeCodeSource } from "../tailing/claude-code.ts";
import { recordAudits } from "../audits/store.ts";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

async function scratch(): Promise<{
  claudeDir: string;
  registryPath: string;
  repo: string;
  root: string;
  statusPath: string;
  transcript: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "argus-status-origin-audit-"));
  roots.push(root);
  const repo = join(root, "repo");
  const claudeDir = join(root, "claude-project");
  const transcript = join(claudeDir, "session.jsonl");
  const registryPath = join(root, "repos");
  const statusPath = join(root, "supervisor-status.json");
  await Promise.all([mkdir(repo, { recursive: true }), mkdir(claudeDir, { recursive: true })]);
  await Bun.write(registryPath, `${repo}\n`);
  return { claudeDir, registryPath, repo, root, statusPath, transcript };
}

function userRecord(originKind?: string): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: "confirm deployment" },
    timestamp: "2026-08-25T20:00:00.000Z",
    promptSource: "sdk",
    ...(originKind === undefined ? {} : { origin: { kind: originKind } }),
    uuid: "origin-audit-1",
    sessionId: "session-origin-audit",
    cwd: "/tmp/project",
    version: "2.1.246",
    isSidechain: false,
  };
}

async function ingestAudits(
  source: ReturnType<typeof createClaudeCodeSource>,
  repo: string,
): Promise<void> {
  const batch = await new ProvenanceFeed(source, repo).catchUp();
  await recordAudits(repo, "reviewer", batch.audits);
}

async function runStatus(
  options: Awaited<ReturnType<typeof scratch>>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, cli, "status"], {
    env: {
      ...Bun.env,
      HOME: options.root,
      ARGUS_REPOS_FILE: options.registryPath,
      ARGUS_SUPERVISOR_STATUS_FILE: options.statusPath,
      ARGUS_SUPERVISOR_CONTROL: "disabled",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("argus status audit alarms", () => {
  test("reports a live watcher with no health report as degraded", async () => {
    const options = await scratch();
    await Bun.write(
      options.statusPath,
      `${JSON.stringify({
        updatedAt: "2026-08-26T12:00:00.000Z",
        watchers: [
          {
            eye: "reviewer",
            pid: process.pid,
            repo: options.repo,
            state: "running",
          },
        ],
      })}\n`,
    );

    const result = await runStatus(options);

    expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
      exitCode: 1,
      stdout: expect.stringContaining("reviewer  degraded"),
    });
  });

  test("surfaces the first refusal of an unknown Claude origin kind", async () => {
    const options = await scratch();
    await mkdir(dirname(options.transcript), { recursive: true });
    await Bun.write(options.transcript, `${JSON.stringify(userRecord("human_v2"))}\n`);
    const source = createClaudeCodeSource({ dir: options.claudeDir });

    await ingestAudits(source, options.repo);
    const result = await runStatus(options);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("claude-origin-kind-refused");
    expect(result.stdout).toContain('\"kind\":\"human_v2\"');
  });

  test("does not re-alarm on the second through hundredth refusal of one kind", async () => {
    const options = await scratch();
    const records = Array.from({ length: 100 }, (_, index) => ({
      ...userRecord("operator"),
      uuid: `origin-audit-${index + 1}`,
    }));
    await Bun.write(
      options.transcript,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const source = createClaudeCodeSource({ dir: options.claudeDir });

    await ingestAudits(source, options.repo);
    const result = await runStatus(options);

    expect(result.exitCode).toBe(1);
    expect(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("  claude-origin-kind-refused  ")),
    ).toHaveLength(1);
  });

  test("does not alarm on the normal headless record shape with no origin", async () => {
    const options = await scratch();
    await Bun.write(options.transcript, `${JSON.stringify(userRecord())}\n`);
    const source = createClaudeCodeSource({ dir: options.claudeDir });

    await ingestAudits(source, options.repo);
    const result = await runStatus(options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("AUDIT ALERTS");
    expect(result.stdout).not.toContain("origin.kind");
  });

  test("keeps the same origin-kind alarm independent in each repo", async () => {
    const options = await scratch();
    const secondRepo = join(options.root, "second-repo");
    const secondClaudeDir = join(options.root, "second-claude-project");
    const secondTranscript = join(secondClaudeDir, "session.jsonl");
    await Promise.all([
      mkdir(secondRepo, { recursive: true }),
      mkdir(secondClaudeDir, { recursive: true }),
    ]);
    await Bun.write(options.registryPath, `${options.repo}\n${secondRepo}\n`);
    await Promise.all([
      Bun.write(options.transcript, `${JSON.stringify(userRecord("human_v2"))}\n`),
      Bun.write(secondTranscript, `${JSON.stringify(userRecord("human_v2"))}\n`),
    ]);

    await ingestAudits(
      createClaudeCodeSource({ dir: options.claudeDir }),
      options.repo,
    );
    await ingestAudits(
      createClaudeCodeSource({ dir: secondClaudeDir }),
      secondRepo,
    );
    const result = await runStatus(options);

    expect(result.exitCode).toBe(1);
    expect(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("  claude-origin-kind-refused  ")),
    ).toHaveLength(2);
    expect(result.stdout).toContain(options.repo);
    expect(result.stdout).toContain(secondRepo);
  });

  test("imports an existing global origin alarm without letting it go quiet", async () => {
    const options = await scratch();
    const legacyDirectory = `${options.registryPath}.audits/claude-origin-kind-refusals`;
    await mkdir(legacyDirectory, { recursive: true });
    await Bun.write(
      join(legacyDirectory, "legacy-human-v2.json"),
      `${JSON.stringify({
        kind: "human_v2",
        repo: options.repo,
        sessionId: "legacy-origin-session",
        ts: "2026-08-25T20:00:00.000Z",
      })}\n`,
    );

    const result = await runStatus(options);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("claude-origin-kind-refused");
    expect(result.stdout).toContain("legacy-origin-session");
    expect(result.stdout).toContain(options.repo);
  });
});
