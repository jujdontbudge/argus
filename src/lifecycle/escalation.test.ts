import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDigest } from "../eyes/digest/outputs.ts";
import {
  escalateNeedsJohan,
  type EscalationTrigger,
  type MacNotificationRequest,
} from "./escalation.ts";

const scratch: string[] = [];

async function repoFixture(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-escalation-"));
  scratch.push(repo);
  await mkdir(join(repo, ".argus"), { recursive: true });
  return repo;
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((repo) => rm(repo, { force: true, recursive: true })));
});

function trigger(kind: EscalationTrigger["kind"], overrides: Record<string, unknown> = {}): EscalationTrigger {
  const base = {
    kind,
    sessionId: "session-189",
    ticket: "189",
    ...overrides,
  };
  if (kind === "nudge-budget-exhausted") {
    return { liveState: "stalled-live", ...base } as EscalationTrigger;
  }
  if (kind === "r2-bailout") {
    return { consequentialChoiceRecordedOnTicket: true, ...base } as EscalationTrigger;
  }
  if (kind === "dispatched-ticket-death") {
    return { deathCount: 2, automaticRelaunchCount: 1, ...base } as EscalationTrigger;
  }
  return { parkedHours: 72, ...base } as EscalationTrigger;
}

async function lifecycleRows(repo: string): Promise<Record<string, unknown>[]> {
  const path = join(repo, ".argus/registry/lifecycle.jsonl");
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("needs-Johan escalation routing", () => {
  test.each([
    ["nudge-budget-exhausted", "nudge budget exhausted while stalled-live"],
    ["r2-bailout", "R2 bail-out"],
    ["dispatched-ticket-death", "second death after automatic relaunch"],
    ["grill-park-proposal", "grill 72h park proposal"],
  ] as const)("%s creates one digest marker and one bounded push", async (kind, cause) => {
    const repo = await repoFixture();
    const notifications: MacNotificationRequest[] = [];

    const result = await escalateNeedsJohan(repo, trigger(kind), {
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      notify: async (request) => {
        notifications.push(request);
      },
    });

    expect(result.status).toBe("escalated");
    const digest = await readDigest(join(repo, ".argus/sessions"), "189-session-189.md");
    expect(digest?.body.match(/\[needs-johan\]/g)).toHaveLength(1);
    expect(digest?.body).toContain(`[needs-johan] ticket #189: ${cause}`);
    expect(notifications).toEqual([
      {
        title: "Argus needs Johan",
        body: `#189 ${cause}`,
      },
    ]);
    expect(Buffer.byteLength(notifications[0]!.body, "utf8")).toBeLessThanOrEqual(256);

    const rows = await lifecycleRows(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "needs-johan-escalation",
      sessionId: "session-189",
      ticket: "189",
      cause,
    });
  });

  test("dedupes a session and cause across a simulated restart", async () => {
    const repo = await repoFixture();
    const notifications: MacNotificationRequest[] = [];
    const options = {
      notify: async (request: MacNotificationRequest) => {
        notifications.push(request);
      },
    };

    await escalateNeedsJohan(repo, trigger("r2-bailout"), options);
    const restarted = await escalateNeedsJohan(repo, trigger("r2-bailout"), options);

    expect(restarted.status).toBe("duplicate");
    expect(notifications).toHaveLength(1);
    expect((await lifecycleRows(repo))).toHaveLength(1);
    const digest = await readDigest(join(repo, ".argus/sessions"), "189-session-189.md");
    expect(digest?.body.match(/\[needs-johan\]/g)).toHaveLength(1);
  });

  test("dedupes a rotated session against its existing digest-chain root", async () => {
    const repo = await repoFixture();
    await mkdir(join(repo, ".argus/registry"), { recursive: true });
    await writeFile(
      join(repo, ".argus/registry/sessions.jsonl"),
      [
        {
          ts: "2026-08-31T11:59:00.000Z",
          sessionId: "session-root",
          ticket: "189",
          dispatchPrompt: "work",
        },
        {
          ts: "2026-08-31T12:00:00.000Z",
          sessionId: "session-rotated",
          ticket: "189",
          continues: "session-root",
          dispatchPrompt: "continued work",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const notifications: MacNotificationRequest[] = [];

    await escalateNeedsJohan(repo, trigger("r2-bailout", { sessionId: "session-root" }), {
      notify: async (request) => {
        notifications.push(request);
      },
    });
    const restarted = await escalateNeedsJohan(
      repo,
      trigger("r2-bailout", { sessionId: "session-rotated" }),
      {
        notify: async (request) => {
          notifications.push(request);
        },
      },
    );

    expect(restarted.status).toBe("duplicate");
    expect(notifications).toHaveLength(1);
    expect((await lifecycleRows(repo))).toHaveLength(1);
    const digest = await readDigest(join(repo, ".argus/sessions"), "189-session-root.md");
    expect(digest?.body.match(/\[needs-johan\]/g)).toHaveLength(1);
  });

  test("the push ignores transcript-shaped free text and stays bounded", async () => {
    const repo = await repoFixture();
    const notifications: MacNotificationRequest[] = [];
    const withTranscript = {
      ...trigger("nudge-budget-exhausted"),
      transcript: "SECRET TRANSCRIPT CONTENT MUST NEVER REACH JOHAN",
    } as unknown as EscalationTrigger;

    await escalateNeedsJohan(repo, withTranscript, {
      notify: async (request) => {
        notifications.push(request);
      },
    });

    expect(notifications[0]).toEqual({
      title: "Argus needs Johan",
      body: "#189 nudge budget exhausted while stalled-live",
    });
    expect(JSON.stringify(notifications)).not.toContain("SECRET TRANSCRIPT");
  });

  test.each([
    trigger("nudge-budget-exhausted", { liveState: "running" }),
    trigger("r2-bailout", { consequentialChoiceRecordedOnTicket: false }),
    trigger("dispatched-ticket-death", { deathCount: 1 }),
    trigger("dispatched-ticket-death", { automaticRelaunchCount: 0 }),
    trigger("grill-park-proposal", { parkedHours: 71.99 }),
    {
      kind: "unknown-trigger",
      sessionId: "session-189",
      ticket: "189",
    } as unknown as EscalationTrigger,
  ])("does not escalate a non-trigger: %o", async (candidate) => {
    const repo = await repoFixture();
    const notifications: MacNotificationRequest[] = [];

    const result = await escalateNeedsJohan(repo, candidate, {
      notify: async (request) => {
        notifications.push(request);
      },
    });

    expect(result.status).toBe("ignored");
    expect(notifications).toEqual([]);
    expect(await Bun.file(join(repo, ".argus/registry/lifecycle.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(repo, ".argus/sessions/189-session-189.md")).exists()).toBe(false);
  });

  test("fails closed for malformed runtime trigger data", async () => {
    const repo = await repoFixture();
    const notifications: MacNotificationRequest[] = [];
    const malformed = {
      kind: "nudge-budget-exhausted",
      sessionId: undefined,
      ticket: "189",
      liveState: "stalled-live",
    } as unknown as EscalationTrigger;

    const result = await escalateNeedsJohan(repo, malformed, {
      notify: async (request) => {
        notifications.push(request);
      },
    });

    expect(result).toEqual({ status: "ignored", reason: "not-trigger" });
    expect(notifications).toEqual([]);
    expect(await Bun.file(join(repo, ".argus/registry/lifecycle.jsonl")).exists()).toBe(false);
  });

  test.each([undefined, null, "not-an-object", 42])(
    "fails closed for malformed non-object trigger data: %o",
    async (candidate) => {
      const repo = await repoFixture();
      const notifications: MacNotificationRequest[] = [];

      const result = await escalateNeedsJohan(
        repo,
        candidate as unknown as EscalationTrigger,
        {
          notify: async (request) => {
            notifications.push(request);
          },
        },
      );

      expect(result).toEqual({ status: "ignored", reason: "not-trigger" });
      expect(notifications).toEqual([]);
      expect(await Bun.file(join(repo, ".argus/registry/lifecycle.jsonl")).exists()).toBe(false);
    },
  );

  test("does not mutate ticket or surface state", async () => {
    const repo = await repoFixture();
    const ticket = join(repo, ".argus", "ticket.json");
    const surface = join(repo, ".argus", "surface.json");
    await writeFile(ticket, '{"state":"open"}\n');
    await writeFile(surface, '{"focused":"surface:1"}\n');
    const before = {
      ticket: await readFile(ticket, "utf8"),
      surface: await readFile(surface, "utf8"),
    };

    await escalateNeedsJohan(repo, trigger("dispatched-ticket-death"), {
      notify: async () => {},
    });

    expect(await readFile(ticket, "utf8")).toBe(before.ticket);
    expect(await readFile(surface, "utf8")).toBe(before.surface);
  });
});
