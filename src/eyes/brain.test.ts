import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexBrain,
  parseCodexOutput,
  type SpawnRequest,
} from "./brain";

const AGENT_MESSAGE_JSONL = [
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "turn.started" }),
  "not json — codex stderr noise that leaked, must be tolerated",
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: '{"findings":[]}' },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 18_119,
      cached_input_tokens: 8_960,
      output_tokens: 50,
    },
  }),
].join("\n");

describe("codex exec --json output parsing (research #8)", () => {
  test("takes the agent_message item text and the turn usage", () => {
    const outcome = parseCodexOutput(AGENT_MESSAGE_JSONL);
    expect(outcome).toEqual({
      ok: true,
      text: '{"findings":[]}',
      usage: {
        inputTokens: 18_119,
        cachedInputTokens: 8_960,
        outputTokens: 50,
      },
    });
  });

  test("turn.failed is a failure even when an agent_message came before it", () => {
    const outcome = parseCodexOutput(
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "partial" },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "usage limit" } }),
      ].join("\n"),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("turn-failed");
      expect(outcome.detail).toContain("usage limit");
    }
  });

  test("no agent_message at all is a failure", () => {
    const outcome = parseCodexOutput(
      JSON.stringify({ type: "turn.completed", usage: {} }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("no-agent-message");
  });
});

describe("createCodexBrain — the exact researched invocation", () => {
  test("a hung spawn times out and the brain survives for the next evaluation", async () => {
    let attempts = 0;
    const brain = createCodexBrain({
      attemptTimeoutMs: 20,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      spawn: async () => {
        attempts += 1;
        if (attempts === 1) return await new Promise(() => {});
        return { exitCode: 0, stdout: AGENT_MESSAGE_JSONL, stderr: "" };
      },
    });

    const first = await Promise.race([
      brain.evaluate({ prompt: "p", schema: {}, cwd: "/tmp" }),
      Bun.sleep(100).then(() => "test-watchdog" as const),
    ]);

    expect(first).not.toBe("test-watchdog");
    expect(first).toEqual({
      ok: false,
      reason: "spawn-error",
      detail: "brain attempt timed out after 20ms",
    });
    expect(
      await brain.evaluate({ prompt: "p", schema: {}, cwd: "/tmp" }),
    ).toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  test("caller shutdown aborts a hung evaluation before its deadline", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let started!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const brain = createCodexBrain({
      attemptTimeoutMs: 60_000,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      spawn: async (request) => {
        requestSignal = request.signal;
        started();
        return await new Promise(() => {});
      },
    });

    const evaluation = brain.evaluate({
      prompt: "p",
      schema: {},
      cwd: "/tmp",
      signal: controller.signal,
    });
    await spawnStarted;
    controller.abort();

    expect(
      await Promise.race([
        evaluation,
        Bun.sleep(100).then(() => "test-watchdog" as const),
      ]),
    ).toEqual({
      ok: false,
      reason: "spawn-error",
      detail: "brain attempt aborted by caller",
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  test("the default spawn kills its child when the attempt times out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-brain-child-"));
    const binary = join(directory, "hung-codex");
    const pidFile = join(directory, "pid");
    let childPid: number | undefined;
    try {
      await Bun.write(
        binary,
        [
          "#!/usr/bin/env bun",
          "await Bun.write(process.env.ARGUS_TEST_CHILD_PID, String(process.pid));",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
      const brain = createCodexBrain({
        attemptTimeoutMs: 1_000,
        binary,
        env: { ...process.env, ARGUS_TEST_CHILD_PID: pidFile },
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      });

      expect(
        await brain.evaluate({ prompt: "p", schema: {}, cwd: directory }),
      ).toEqual({
        ok: false,
        reason: "spawn-error",
        detail: "brain attempt timed out after 1000ms",
      });
      childPid = Number(await Bun.file(pidFile).text());
      for (let attempt = 0; attempt < 100 && processIsAlive(childPid); attempt += 1) {
        await Bun.sleep(5);
      }
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      if (childPid !== undefined && processIsAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("spawns the lean luna argv with prompt on stdin and the schema in a temp file", async () => {
    const requests: Array<SpawnRequest & { schemaOnDisk: unknown }> = [];
    const brain = createCodexBrain({
      env: {
        HOME: "/subscription-home",
        OPENAI_API_KEY: "must-not-reach-codex",
      },
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      spawn: async (request) => {
        const schemaFile = request.argv[request.argv.indexOf("--output-schema") + 1]!;
        requests.push({
          ...request,
          schemaOnDisk: JSON.parse(await Bun.file(schemaFile).text()),
        });
        return { exitCode: 0, stdout: AGENT_MESSAGE_JSONL, stderr: "" };
      },
    });

    const outcome = await brain.evaluate({
      prompt: "classify this batch",
      schema: { type: "object", properties: { findings: {} } },
      cwd: "/tmp/some-repo",
    });

    expect(outcome.ok).toBe(true);
    expect(requests.length).toBe(1);
    const request = requests[0]!;
    expect(request.stdin).toBe("classify this batch");
    expect(request.env.HOME).toBe("/subscription-home");
    expect(request.env.OPENAI_API_KEY).toBeUndefined();
    expect(request.schemaOnDisk).toEqual({
      type: "object",
      properties: { findings: {} },
    });
    const argv = [...request.argv];
    const schemaFile = argv[argv.indexOf("--output-schema") + 1]!;
    expect(argv).toEqual([
      "codex",
      "exec",
      "--ignore-user-config",
      "-m",
      "gpt-5.6-luna",
      "-c",
      "model_reasoning_effort=low",
      "-s",
      "read-only",
      "--ephemeral",
      "-C",
      "/tmp/some-repo",
      "--skip-git-repo-check",
      "-c",
      "project_doc_max_bytes=0",
      "--output-schema",
      schemaFile,
      "--json",
      "-",
    ]);
  });

  test("temp schema file is cleaned up after the call", async () => {
    let schemaFile = "";
    const brain = createCodexBrain({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      spawn: async (request) => {
        schemaFile = request.argv[request.argv.indexOf("--output-schema") + 1]!;
        return { exitCode: 0, stdout: AGENT_MESSAGE_JSONL, stderr: "" };
      },
    });
    await brain.evaluate({ prompt: "p", schema: {}, cwd: "/tmp" });
    expect(schemaFile).not.toBe("");
    expect(await Bun.file(schemaFile).exists()).toBe(false);
  });

  test("nonzero exit is a failure carrying stderr", async () => {
    const brain = createCodexBrain({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      spawn: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "ERROR: 400 model not supported",
      }),
    });
    const outcome = await brain.evaluate({ prompt: "p", schema: {}, cwd: "/tmp" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("nonzero-exit");
      expect(outcome.detail).toContain("400");
    }
  });
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
