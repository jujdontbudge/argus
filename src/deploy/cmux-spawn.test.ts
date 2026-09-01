import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CmuxRun } from "../events";
import { createCmuxWorkerSpawn } from "./cmux-spawn.ts";

const WORKSPACE = "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10";
const SURFACE = "AAAA1111-2222-4333-8444-555555555555";
const THREAD = "01a050f4-a85c-7bd0-b542-c0354a088959";

function inventory() {
  return JSON.stringify({
    windows: [
      {
        workspaces: [
          {
            id: WORKSPACE,
            panes: [{ ref: "pane:1", surfaces: [{ id: SURFACE, ref: "surface:2" }] }],
            ref: "workspace:1",
          },
        ],
      },
    ],
  });
}

async function completeReadinessProbe(args: readonly string[]): Promise<boolean> {
  const command = args.at(-1) ?? "";
  if (args[0] !== "send" || !command.includes("/bin/mkdir")) return false;
  const encodedPath = command.match(/printf %s '([^']+)'/)?.[1];
  if (encodedPath === undefined) throw new Error("readiness probe did not encode its marker path");
  await mkdir(Buffer.from(encodedPath, "base64").toString("utf8"));
  return true;
}

describe("cmux worker lifecycle (#122)", () => {
  test("launches the routed worker in its resolved surface and observes id plus exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-cmux-worker-"));
    const logFile = join(dir, "worker output.log");
    const calls: string[][] = [];
    let launchScript = "";
    try {
      const cmux: CmuxRun = async (args) => {
        calls.push([...args]);
        if (args.includes("tree")) return { exitCode: 0, stderr: "", stdout: inventory() };
        if (args[0] === "send") {
          if (await completeReadinessProbe(args)) {
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          launchScript = await readFile(
            `${logFile}.launch-test-exit-token.zsh`,
            "utf8",
          );
          await appendFile(logFile, "[argus-pid:test-exit-token] 4242\n");
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const spawn = createCmuxWorkerSpawn({
        cmux,
        exitToken: "test-exit-token",
        inputSurface: "surface:2",
        settleDelayMs: 0,
        surface: SURFACE,
        workspace: WORKSPACE,
      });

      const worker = await spawn({
        agent: "codex",
        announce: (line: string) => {
          try {
            const row = JSON.parse(line) as { thread_id?: string; type?: string };
            return row.type === "thread.started" ? (row.thread_id ?? null) : null;
          } catch {
            return null;
          }
        },
        command: ["codex", "exec", "--json", "line one\nline two\\nline three"],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        executable: "/Users/test/.local/bin/codex",
        logFile,
      });
      expect(await Bun.file(`${logFile}.launch-test-exit-token.zsh`).exists()).toBe(false);

      const sends = calls.filter((args) => args[0] === "send");
      const readiness = sends.find((args) => args.at(-1)?.includes("/bin/mkdir"));
      const send = sends.find((args) => args.at(-1)?.includes("/bin/zsh"));
      expect(readiness).toBeDefined();
      expect(send).toBeDefined();
      expect(sends).toHaveLength(2);
      expect(sends.indexOf(readiness!)).toBeLessThan(sends.indexOf(send!));
      expect(send).toContain("--surface");
      expect(send).toContain("surface:2");
      expect(calls.some((args) => args.includes("tree"))).toBe(true);
      const line = send?.at(-1) ?? "";
      expect(line.endsWith("\n")).toBe(true);
      expect(line).toContain("/bin/zsh");
      expect(line).not.toContain("line one");
      expect(line).not.toContain("worker output.log");
      const encodedPath = line.match(/printf %s '([^']+)'/)?.[1];
      expect(encodedPath).toBeDefined();
      expect(Buffer.from(encodedPath ?? "", "base64").toString("utf8")).toBe(
        `${logFile}.launch-test-exit-token.zsh`,
      );
      expect(launchScript).toContain("tee");
      const transported = [
        ...launchScript.matchAll(/printf %s '([^']*)' \| \/usr\/bin\/base64 -D/g),
      ].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
      expect(transported).toContain("/Users/test/.local/bin/codex");
      expect(transported).toContain(
        "line one\nline two\\nline three",
      );
      expect(calls.filter((args) => args[0] === "send-key")).toEqual([]);
      expect(worker.pid).toBe(4242);

      await appendFile(
        logFile,
        `${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n` +
          `[argus-exit:test-exit-token] 7\n`,
      );
      expect(await worker.announcedSessionId()).toBe(THREAD);
      expect(await worker.exited).toMatchObject({ exitCode: 7 });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("executes the launch script and records the real shell exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-cmux-execution-"));
    const logFile = join(dir, "worker.log");
    const launchFile = `${logFile}.launch-execution-token.zsh`;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const cmux: CmuxRun = async (args) => {
        if (args.includes("tree")) return { exitCode: 0, stderr: "", stdout: inventory() };
        if (await completeReadinessProbe(args)) {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (args[0] === "send") {
          child = Bun.spawn(["/bin/zsh", launchFile], { stderr: "ignore", stdout: "ignore" });
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const spawn = createCmuxWorkerSpawn({
        cmux,
        exitToken: "execution-token",
        inputSurface: "surface:2",
        settleDelayMs: 0,
        surface: SURFACE,
        workspace: WORKSPACE,
      });

      const worker = await spawn({
        agent: "codex",
        announce: (line: string) => {
          try {
            const row = JSON.parse(line) as { thread_id?: string; type?: string };
            return row.type === "thread.started" ? (row.thread_id ?? null) : null;
          } catch {
            return null;
          }
        },
        command: [
          "codex",
          "-c",
          `printf '%s\\n' '${JSON.stringify({ type: "thread.started", thread_id: THREAD })}'; printf visible; exit 7`,
        ],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        executable: "/bin/sh",
        logFile,
      });

      expect(worker.pid).toBe(child?.pid);
      const announced = await Promise.race([
        worker.announcedSessionId(),
        Bun.sleep(1_000).then(() => {
          throw new Error("timed out waiting for execution-test announcement");
        }),
      ]);
      expect(announced).toBe(THREAD);
      const exited = await Promise.race([
        worker.exited,
        Bun.sleep(1_000).then(() => {
          throw new Error("timed out waiting for execution-test exit");
        }),
      ]);
      expect(exited).toMatchObject({ exitCode: 7 });
      expect(await Bun.file(launchFile).exists()).toBe(false);
    } catch (error) {
      console.error(await Bun.file(logFile).text());
      throw error;
    } finally {
      child?.kill();
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("fails quickly when cmux accepts input but no worker pid appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-cmux-no-pid-"));
    const logFile = join(dir, "worker.log");
    try {
      const cmux: CmuxRun = async (args) => {
        if (args.includes("tree")) return { exitCode: 0, stderr: "", stdout: inventory() };
        if (await completeReadinessProbe(args)) {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const spawn = createCmuxWorkerSpawn({
        cmux,
        exitToken: "missing-pid-token",
        inputSurface: "surface:2",
        settleDelayMs: 0,
        startupTimeoutMs: 20,
        surface: SURFACE,
        workspace: WORKSPACE,
      });

      await expect(
        spawn({
          agent: "codex",
          command: ["codex", "exec", "--json", "prompt"],
          cwd: dir,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          executable: "/Users/test/.local/bin/codex",
          logFile,
        }),
      ).rejects.toThrow("timed out waiting for cmux worker pid");
      expect(await Bun.file(`${logFile}.launch-missing-pid-token.zsh`).exists()).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("does not retry a failed atomic verified-ref send and removes its launch file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-cmux-send-failure-"));
    const logFile = join(dir, "worker.log");
    const calls: string[][] = [];
    try {
      const cmux: CmuxRun = async (args) => {
        calls.push([...args]);
        if (args.includes("tree")) return { exitCode: 0, stderr: "", stdout: inventory() };
        if (await completeReadinessProbe(args)) {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (args[0] === "send") {
          return {
            exitCode: 1,
            stderr: "internal_error: socket write failed after request",
            stdout: "",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const spawn = createCmuxWorkerSpawn({
        cmux,
        exitToken: "send-failure-token",
        inputSurface: "surface:2",
        settleDelayMs: 0,
        surface: SURFACE,
        workspace: WORKSPACE,
      });

      await expect(
        spawn({
          agent: "codex",
          command: ["codex", "exec", "--json", "prompt"],
          cwd: dir,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          executable: "/Users/test/.local/bin/codex",
          logFile,
        }),
      ).rejects.toThrow("socket write failed after request");
      const launchSends = calls.filter(
        (args) => args[0] === "send" && args.at(-1)?.includes("/bin/zsh"),
      );
      expect(launchSends).toHaveLength(1);
      expect(await Bun.file(`${logFile}.launch-send-failure-token.zsh`).exists()).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});