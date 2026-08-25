import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProvenanceRecord } from "../../provenance";
import type {
  HonchoIngestionClient,
  HonchoMessageInput,
  HonchoPeerInput,
  HonchoSessionInput,
  HonchoWorkspaceInput,
} from "../../up/bindings";
import { HonchoEye } from "./honcho";

const scratchDirectories: string[] = [];

class FakeHoncho implements HonchoIngestionClient {
  readonly delivered: HonchoMessageInput[] = [];
  readonly calls: Array<
    | { type: "workspace"; input: HonchoWorkspaceInput }
    | { type: "peer"; workspace: string; input: HonchoPeerInput }
    | { type: "session"; workspace: string; input: HonchoSessionInput }
    | {
        type: "messages";
        workspace: string;
        session: string;
        messages: readonly HonchoMessageInput[];
      }
  > = [];

  constructor(private failuresRemaining = 0) {}

  async ensureWorkspace(input: HonchoWorkspaceInput) {
    this.calls.push({ type: "workspace", input });
    return "created" as const;
  }

  async ensurePeer(workspace: string, input: HonchoPeerInput) {
    this.calls.push({ type: "peer", workspace, input });
    return "created" as const;
  }

  async ensureSession(workspace: string, input: HonchoSessionInput) {
    this.calls.push({ type: "session", workspace, input });
    return "created" as const;
  }

  async createMessages(
    workspace: string,
    session: string,
    messages: readonly HonchoMessageInput[],
  ) {
    this.calls.push({ type: "messages", workspace, session, messages });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Honcho fixture is down");
    }
    this.delivered.push(...messages);
  }
}

function record(
  text: string,
  author: ProvenanceRecord["author"],
  options: {
    agent?: string;
    sessionId?: string;
    ts?: string;
    uuid?: string;
    via?: ProvenanceRecord["via"];
  } = {},
): ProvenanceRecord {
  const uuid = options.uuid ?? `uuid-${text}`;
  const sessionId = options.sessionId ?? "session-32";
  const ts = options.ts ?? "2026-08-25T12:00:00.000Z";
  return {
    sessionId,
    author,
    via: options.via ?? (author === "agent" ? "assistant" : "takeover"),
    registered: true,
    startedBy: "hermes",
    johanTouched: author === "johan",
    agent: options.agent ?? "claude",
    ticket: "32",
    ts,
    text,
    event: {
      type: "message",
      sessionId,
      role: author === "agent" ? "assistant" : "user",
      text,
      ts,
      uuid,
      candidate: true,
      file: `/scratch/transcripts/${sessionId}.jsonl`,
    },
  };
}

async function scratchRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-honcho-eye-"));
  scratchDirectories.push(repo);
  await mkdir(join(repo, ".argus"), { recursive: true });
  await Bun.write(
    join(repo, ".argus/honcho.yaml"),
    "url: http://honcho.fixture\nworkspace: scratch-honcho-eye\n",
  );
  return repo;
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Honcho eye", () => {
  test("routes classified authors to isolated peers with provenance on every message", async () => {
    const repo = await scratchRepo();
    const client = new FakeHoncho();
    const eye = await HonchoEye.open({
      repo,
      client,
      autoFlush: false,
      onAlert: () => {},
    });

    await eye.ingest([
      record("Johan directive", "johan", { via: "takeover" }),
      record("Hermes nudge", "hermes", { agent: "claude", via: "registry-send" }),
      record("Claude output", "agent", { agent: "claude" }),
      record("Codex output", "agent", { agent: "codex" }),
    ]);
    await eye.flush();

    expect(client.calls.slice(0, 5)).toEqual([
      {
        type: "workspace",
        input: { id: "scratch-honcho-eye", metadata: { repo } },
      },
      {
        type: "peer",
        workspace: "scratch-honcho-eye",
        input: { id: "johan" },
      },
      {
        type: "peer",
        workspace: "scratch-honcho-eye",
        input: { configuration: { observe_me: false }, id: "claude-code" },
      },
      {
        type: "peer",
        workspace: "scratch-honcho-eye",
        input: { configuration: { observe_me: false }, id: "codex" },
      },
      {
        type: "peer",
        workspace: "scratch-honcho-eye",
        input: { configuration: { observe_me: false }, id: "hermes" },
      },
    ]);
    expect(client.calls[5]).toMatchObject({
      type: "session",
      workspace: "scratch-honcho-eye",
      input: {
        id: "session-32",
        metadata: { agent: "claude", ticket: "32" },
      },
    });
    const sent = client.calls[6];
    expect(sent?.type).toBe("messages");
    if (sent?.type !== "messages") throw new Error("missing message call");
    expect(sent.messages.map(({ peer_id }) => peer_id)).toEqual([
      "johan",
      "hermes",
      "claude-code",
      "codex",
    ]);
    expect(sent.messages.map(({ content }) => content)).toEqual([
      "Johan directive",
      "Hermes nudge",
      "Claude output",
      "Codex output",
    ]);
    for (const message of sent.messages) {
      expect(message.metadata).toMatchObject({
        session_id: "session-32",
        registered: true,
        started_by: "hermes",
        source_file: "/scratch/transcripts/session-32.jsonl",
        ticket: "32",
        timestamp: "2026-08-25T12:00:00.000Z",
      });
      expect(message.metadata.provenance).toBeString();
      expect(message.metadata.via).toBeString();
    }
    expect(await eye.pendingCount()).toBe(0);
  });

  test("survives restart and retries a durable backlog with backoff and a prolonged-failure alert", async () => {
    const repo = await scratchRepo();
    const down = new FakeHoncho();
    const beforeRestart = await HonchoEye.open({
      repo,
      client: down,
      autoFlush: false,
      onAlert: () => {},
    });
    await beforeRestart.ingest([
      record("first durable message", "johan"),
      record("second durable message", "agent", { agent: "codex" }),
    ]);

    expect(await beforeRestart.pendingCount()).toBe(2);
    expect(
      (await Bun.file(join(repo, ".argus/eyes/honcho/queue.json")).json())
        .messages,
    ).toHaveLength(2);

    let now = 0;
    const slept: number[] = [];
    const alerts: Array<{ eye: string; lastError: string }> = [];
    const recovered = new FakeHoncho(3);
    const afterRestart = await HonchoEye.open({
      repo,
      client: recovered,
      autoFlush: false,
      onAlert: (alert) => {
        alerts.push(alert);
      },
      retry: {
        baseDelayMs: 10,
        maxDelayMs: 20,
        stuckAfterMs: 15,
        now: () => now,
        sleep: async (ms) => {
          slept.push(ms);
          now += ms;
        },
      },
    });
    await afterRestart.flush();

    expect(slept).toEqual([10, 20, 20]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eye: "honcho",
      lastError: "Honcho fixture is down",
    });
    expect(recovered.delivered.map(({ content }) => content)).toEqual([
      "first durable message",
      "second durable message",
    ]);
    expect(await afterRestart.pendingCount()).toBe(0);
  });

  test("splits backlogs at 100 without reordering messages across sessions", async () => {
    const repo = await scratchRepo();
    const client = new FakeHoncho();
    const eye = await HonchoEye.open({
      repo,
      client,
      autoFlush: false,
      onAlert: () => {},
    });
    const records: ProvenanceRecord[] = [];
    for (let index = 0; index < 205; index += 1) {
      const sessionId =
        index < 102 ? "source-a" : index === 102 ? "source-b" : "source-a";
      records.push(
        record(`ordered-${index}`, "agent", {
          agent: "codex",
          sessionId,
          ts: new Date(Date.parse("2026-08-25T12:00:00.000Z") + index).toISOString(),
        }),
      );
    }

    await eye.ingest(records);
    await eye.flush();

    const batches = client.calls.filter(
      (call): call is Extract<(typeof client.calls)[number], { type: "messages" }> =>
        call.type === "messages",
    );
    expect(batches.map(({ messages }) => messages.length)).toEqual([100, 2, 1, 100, 2]);
    expect(batches.map(({ session }) => session)).toEqual([
      "source-a",
      "source-a",
      "source-b",
      "source-a",
      "source-a",
    ]);
    expect(client.delivered.map(({ content }) => content)).toEqual(
      Array.from({ length: 205 }, (_, index) => `ordered-${index}`),
    );
    expect(Math.max(...batches.map(({ messages }) => messages.length))).toBe(100);
  });
});
