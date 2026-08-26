import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProvenanceFeed } from "../eyes/source.ts";
import { createClaudeCodeSource } from "../tailing/claude-code.ts";

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

describe("argus status candidacy alarms", () => {
  test("surfaces the first refusal of an unknown Claude origin kind", async () => {
    const options = await scratch();
    await mkdir(dirname(options.transcript), { recursive: true });
    await Bun.write(options.transcript, `${JSON.stringify(userRecord("human_v2"))}\n`);
    const source = createClaudeCodeSource({ dir: options.claudeDir });

    await new ProvenanceFeed(source, options.repo, options.registryPath).catchUp();
    const result = await runStatus(options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('refused Claude origin.kind "human_v2"');
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

    await new ProvenanceFeed(source, options.repo, options.registryPath).catchUp();
    const result = await runStatus(options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.match(/refused Claude origin\.kind "operator"/g)).toHaveLength(1);
  });

  test("does not alarm on the normal headless record shape with no origin", async () => {
    const options = await scratch();
    await Bun.write(options.transcript, `${JSON.stringify(userRecord())}\n`);
    const source = createClaudeCodeSource({ dir: options.claudeDir });

    await new ProvenanceFeed(source, options.repo, options.registryPath).catchUp();
    const result = await runStatus(options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("CANDIDACY ALERTS");
    expect(result.stdout).not.toContain("origin.kind");
  });

  test("deduplicates one origin kind across all enabled repos", async () => {
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

    await new ProvenanceFeed(
      createClaudeCodeSource({ dir: options.claudeDir }),
      options.repo,
      options.registryPath,
    ).catchUp();
    await new ProvenanceFeed(
      createClaudeCodeSource({ dir: secondClaudeDir }),
      secondRepo,
      options.registryPath,
    ).catchUp();
    const result = await runStatus(options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.match(/refused Claude origin\.kind "human_v2"/g)).toHaveLength(1);
  });
});
