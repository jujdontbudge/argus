import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  mkdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convergeAgentBindings,
  HttpHonchoClient,
  type HermesCronRun,
  type HonchoClient,
  type HonchoPeerInput,
  type HonchoWorkspaceInput,
} from "./bindings.ts";

const scratchDirectories: string[] = [];

class FakeHoncho implements HonchoClient {
  readonly peers = new Map<string, Map<string, HonchoPeerInput>>();
  readonly workspaces = new Map<string, HonchoWorkspaceInput>();

  async ensureWorkspace(input: HonchoWorkspaceInput): Promise<"created" | "existing"> {
    const status = this.workspaces.has(input.id) ? "existing" : "created";
    this.workspaces.set(input.id, input);
    return status;
  }

  async ensurePeer(
    workspace: string,
    input: HonchoPeerInput,
  ): Promise<"created" | "existing"> {
    const peers = this.peers.get(workspace) ?? new Map<string, HonchoPeerInput>();
    const status = peers.has(input.id) ? "existing" : "created";
    peers.set(input.id, input);
    this.peers.set(workspace, peers);
    return status;
  }
}

async function scratchRepo(name = "Widget Kit"): Promise<{ repo: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "argus-bindings-"));
  scratchDirectories.push(root);
  const repo = join(root, name);
  await mkdir(join(repo, ".argus", "memory"), { recursive: true });
  return { repo, root };
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("agent binding convergence", () => {
  test("same-basename repos under one home bind separate identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-bindings-collision-"));
    scratchDirectories.push(root);
    const firstRepo = join(root, "first", "shared-name");
    const secondRepo = join(root, "second", "shared-name");
    const hermesRoot = join(root, "home", ".hermes");
    await Promise.all(
      [firstRepo, secondRepo].map((repo) =>
        mkdir(join(repo, ".argus", "memory"), { recursive: true }),
      ),
    );
    const honcho = new FakeHoncho();

    const first = await convergeAgentBindings({
      hermesRoot,
      honcho,
      honchoUrl: "http://honcho.test:8000",
      repo: firstRepo,
    });
    const second = await convergeAgentBindings({
      hermesRoot,
      honcho,
      honchoUrl: "http://honcho.test:8000",
      repo: secondRepo,
    });

    expect(second.workspace).not.toBe(first.workspace);
    expect(second.profile).not.toBe(first.profile);
    for (const [repo, binding] of [
      [firstRepo, first],
      [secondRepo, second],
    ] as const) {
      const memories = join(
        hermesRoot,
        "profiles",
        binding.profile,
        "memories",
      );
      expect(await realpath(memories)).toBe(
        await realpath(join(repo, ".argus", "memory")),
      );
    }
  });

  test("adopts an existing legacy binding without orphaning its memory", async () => {
    const { repo, root } = await scratchRepo("Legacy Repo");
    const canonicalRepo = await realpath(repo);
    const hermesRoot = join(root, "home", ".hermes");
    const legacy = "argus-legacy-repo";
    const legacyProfile = join(hermesRoot, "profiles", legacy);
    await mkdir(legacyProfile, { recursive: true });
    await symlink(
      join(canonicalRepo, ".argus", "memory"),
      join(legacyProfile, "memories"),
    );
    await Bun.write(join(legacyProfile, "state.db"), "existing hermes state");
    await Bun.write(
      join(canonicalRepo, ".argus", "honcho.yaml"),
      `url: http://honcho.test:8000
workspace: ${legacy}
peers:
  johan:
    observe_me: true
`,
    );
    const honcho = new FakeHoncho();
    honcho.workspaces.set(legacy, {
      id: legacy,
      metadata: { repo: canonicalRepo },
    });

    const report = await convergeAgentBindings({
      hermesRoot,
      honcho,
      honchoUrl: "http://honcho.test:8000",
      repo,
    });

    expect(report.workspace).toBe(legacy);
    expect(report.profile).toBe(legacy);
    expect(report.honcho).toBe("existing");
    expect([...honcho.workspaces]).toHaveLength(1);
    expect(await Bun.file(join(legacyProfile, "state.db")).text()).toBe(
      "existing hermes state",
    );
    expect(await realpath(join(legacyProfile, "memories"))).toBe(
      await realpath(join(canonicalRepo, ".argus", "memory")),
    );
    expect(
      await Bun.file(join(canonicalRepo, ".argus", "identity.json")).json(),
    ).toEqual({
      canonicalRepo,
      identity: expect.stringMatching(/^argus-legacy-repo-[a-f0-9]{64}$/),
      profile: legacy,
      version: 1,
      workspace: legacy,
    });
  });

  test("resolves the same identity through a symlinked repo path", async () => {
    const { repo, root } = await scratchRepo("Canonical Repo");
    const alias = join(root, "repo-alias");
    await symlink(repo, alias);
    const hermesRoot = join(root, "home", ".hermes");
    const honcho = new FakeHoncho();
    const options = {
      hermesRoot,
      honcho,
      honchoUrl: "http://honcho.test:8000",
    };

    const direct = await convergeAgentBindings({ ...options, repo });
    const throughAlias = await convergeAgentBindings({ ...options, repo: alias });

    expect(throughAlias.workspace).toBe(direct.workspace);
    expect(throughAlias.profile).toBe(direct.profile);
    expect([...honcho.workspaces]).toHaveLength(1);
  });

  test("refuses an ambiguous legacy binding instead of creating a second one", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-bindings-ambiguous-"));
    scratchDirectories.push(root);
    const repo = join(root, "current", "shared-name");
    const otherRepo = join(root, "other", "shared-name");
    const hermesRoot = join(root, "home", ".hermes");
    await Promise.all(
      [repo, otherRepo].map((path) =>
        mkdir(join(path, ".argus", "memory"), { recursive: true }),
      ),
    );
    const legacy = "argus-shared-name";
    const legacyProfile = join(hermesRoot, "profiles", legacy);
    await mkdir(legacyProfile, { recursive: true });
    await symlink(
      join(otherRepo, ".argus", "memory"),
      join(legacyProfile, "memories"),
    );
    await Bun.write(
      join(repo, ".argus", "honcho.yaml"),
      `url: http://honcho.test:8000\nworkspace: ${legacy}\n`,
    );
    const honcho = new FakeHoncho();

    await expect(
      convergeAgentBindings({
        hermesRoot,
        honcho,
        honchoUrl: "http://honcho.test:8000",
        repo,
      }),
    ).rejects.toThrow("cannot safely migrate legacy binding argus-shared-name");
    expect([...honcho.workspaces]).toHaveLength(0);
    expect(await Bun.file(join(repo, ".argus", "identity.json")).exists()).toBe(
      false,
    );
  });

  test("uses the Honcho v3 get-or-create call sequence", async () => {
    const requests: Array<{
      authorization: string | null;
      body: unknown;
      path: string;
    }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
          path: new URL(request.url).pathname,
        });
        return Response.json({}, { status: requests.length === 1 ? 201 : 200 });
      },
    });

    try {
      const client = new HttpHonchoClient(
        `http://127.0.0.1:${server.port}`,
        "scratch-token",
      );
      expect(
        await client.ensureWorkspace({
          id: "argus-widget-kit",
          metadata: { repo: "/scratch/Widget Kit" },
        }),
      ).toBe("created");
      expect(
        await client.ensurePeer("argus-widget-kit", {
          configuration: { observe_me: false },
          id: "codex",
        }),
      ).toBe("existing");

      expect(requests).toEqual([
        {
          authorization: "Bearer scratch-token",
          body: {
            id: "argus-widget-kit",
            metadata: { repo: "/scratch/Widget Kit" },
          },
          path: "/v3/workspaces",
        },
        {
          authorization: "Bearer scratch-token",
          body: { configuration: { observe_me: false }, id: "codex" },
          path: "/v3/workspaces/argus-widget-kit/peers",
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("uses the Honcho v3 session ensure and per-message batch sequence", async () => {
    const requests: Array<{ body: unknown; path: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          body: await request.json(),
          path: new URL(request.url).pathname,
        });
        return Response.json({}, { status: 201 });
      },
    });

    try {
      const client = new HttpHonchoClient(
        `http://127.0.0.1:${server.port}`,
        "scratch-token",
      );
      await client.ensureSession("scratch-workspace", {
        id: "session/with spaces",
        metadata: { agent: "codex", ticket: "32" },
        peers: {
          johan: {},
          "claude-code": {},
          codex: {},
          hermes: {},
        },
      });
      await client.createMessages("scratch-workspace", "session/with spaces", [
        {
          peer_id: "johan",
          content: "Use the durable queue.",
          metadata: { provenance: "johan", via: "takeover" },
        },
        {
          peer_id: "codex",
          content: "Implemented it.",
          metadata: { provenance: "agent", via: "assistant" },
        },
      ]);

      expect(requests).toEqual([
        {
          body: {
            id: "session/with spaces",
            metadata: { agent: "codex", ticket: "32" },
            peers: {
              johan: {},
              "claude-code": {},
              codex: {},
              hermes: {},
            },
          },
          path: "/v3/workspaces/scratch-workspace/sessions",
        },
        {
          body: {
            messages: [
              {
                peer_id: "johan",
                content: "Use the durable queue.",
                metadata: { provenance: "johan", via: "takeover" },
              },
              {
                peer_id: "codex",
                content: "Implemented it.",
                metadata: { provenance: "agent", via: "assistant" },
              },
            ],
          },
          path:
            "/v3/workspaces/scratch-workspace/sessions/session%2Fwith%20spaces/messages",
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("binds a repo to its Honcho workspace and four peers idempotently", async () => {
    const { repo, root } = await scratchRepo();
    const honcho = new FakeHoncho();
    const options = {
      hermesRoot: join(root, "hermes"),
      honcho,
      honchoUrl: "http://honcho.test:8000",
      repo,
    };

    const first = await convergeAgentBindings(options);
    const second = await convergeAgentBindings(options);
    const canonicalRepo = await realpath(repo);
    const workspace = first.workspace;

    expect(first.honcho).toBe("created");
    expect(second.honcho).toBe("existing");
    expect(workspace).toMatch(/^argus-widget-kit-[a-f0-9]{64}$/);
    expect(second.workspace).toBe(workspace);
    expect(honcho.workspaces.get(workspace)).toEqual({
      id: workspace,
      metadata: { repo: canonicalRepo },
    });
    expect([...honcho.peers.get(workspace)!.values()]).toEqual([
      { id: "johan" },
      { configuration: { observe_me: false }, id: "claude-code" },
      { configuration: { observe_me: false }, id: "codex" },
      { configuration: { observe_me: false }, id: "hermes" },
    ]);
    expect(await Bun.file(join(repo, ".argus", "honcho.yaml")).text()).toBe(
      `url: http://honcho.test:8000
workspace: ${workspace}
peers:
  johan:
    observe_me: true
  claude-code:
    observe_me: false
  codex:
    observe_me: false
  hermes:
    observe_me: false
`,
    );
    expect(
      await Bun.file(
        join(root, "hermes", "profiles", workspace, "config.yaml"),
      ).text(),
    ).toBe(
      `memory:
  memory_char_limit: 12000
  user_char_limit: 6000
curator:
  enabled: false
`,
    );
  });

  test("reports Honcho unavailability while preserving the local binding", async () => {
    const { repo, root } = await scratchRepo("Offline Repo");
    const honcho: HonchoClient = {
      ensurePeer: async () => "created",
      ensureWorkspace: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      },
    };

    const report = await convergeAgentBindings({
      hermesRoot: join(root, "hermes"),
      honcho,
      honchoUrl: "http://localhost:8000",
      repo,
    });

    expect(report.honcho).toBe("unavailable");
    expect(report.honchoError).toBe(
      "connect ECONNREFUSED 127.0.0.1:8000",
    );
    expect(await Bun.file(join(repo, ".argus", "honcho.yaml")).exists()).toBe(
      true,
    );
  });

  test("creates a native Hermes profile with repo memory and curator safety", async () => {
    const { repo, root } = await scratchRepo();
    const hermesRoot = join(root, "hermes");
    await mkdir(hermesRoot, { recursive: true });
    await Bun.write(
      join(hermesRoot, "config.yaml"),
      "model: openai-codex/gpt-5.6-sol\nmemory:\n  memory_enabled: true\n",
    );
    await Bun.write(join(hermesRoot, ".env"), "PROVIDER_TOKEN=scratch\n");
    await Bun.write(join(hermesRoot, "SOUL.md"), "# Scratch soul\n");

    const report = await convergeAgentBindings({
      hermesRoot,
      honcho: new FakeHoncho(),
      honchoUrl: "http://honcho.test:8000",
      repo,
    });

    const profile = join(hermesRoot, "profiles", report.profile);
    expect(report.profile).toMatch(/^argus-widget-kit-[a-f0-9]{64}$/);
    expect((await lstat(profile)).isDirectory()).toBe(true);
    expect((await lstat(join(profile, "memories"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(profile, "memories"))).toBe(
      join(await realpath(repo), ".argus", "memory"),
    );
    expect(await Bun.file(join(profile, ".env")).text()).toBe(
      "PROVIDER_TOKEN=scratch\n",
    );
    expect(await Bun.file(join(profile, "SOUL.md")).text()).toBe(
      "# Scratch soul\n",
    );
    expect(await Bun.file(join(profile, "config.yaml")).text()).toBe(
      `model: openai-codex/gpt-5.6-sol
memory:
  memory_enabled: true
  memory_char_limit: 12000
  user_char_limit: 6000
curator:
  enabled: false
`,
    );
  });

  test("provisions one repo-scoped Hermes slow-poll cron job idempotently", async () => {
    const { repo, root } = await scratchRepo("Signal Consumer");
    const canonicalRepo = await realpath(repo);
    const hermesRoot = join(root, "hermes");
    const calls: Array<{ args: readonly string[]; hermesHome: string }> = [];
    const cron: HermesCronRun = async (args, env) => {
      calls.push({ args, hermesHome: env.HERMES_HOME! });
      const cronDirectory = join(env.HERMES_HOME!, "cron");
      await mkdir(cronDirectory, { recursive: true });
      await Bun.write(
        join(cronDirectory, "jobs.json"),
        `${JSON.stringify({
          jobs: [
            {
              id: "argus-test-job",
              name: "argus-signal-poll",
              script: "argus-signal-poll.sh",
              schedule: { kind: "interval", minutes: 5 },
              schedule_display: "every 5m",
              workdir: canonicalRepo,
              enabled: true,
            },
          ],
        })}\n`,
      );
      return { exitCode: 0, stderr: "", stdout: "Created cron job\n" };
    };
    const options = {
      argusCli: "/opt/argus/src/cli.ts",
      bunExecutable: "/opt/bun/bin/bun",
      hermesCron: cron,
      hermesRoot,
      honcho: new FakeHoncho(),
      honchoUrl: "http://honcho.test:8000",
      repo,
    };

    const first = await convergeAgentBindings(options);
    const second = await convergeAgentBindings(options);

    const profile = join(hermesRoot, "profiles", first.profile);
    const script = join(profile, "scripts", "argus-signal-poll.sh");
    expect(first.cron).toBe("created");
    expect(second.cron).toBe("existing");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.hermesHome).toBe(profile);
    expect(calls[0]!.args).toEqual([
      "cron",
      "create",
      "every 5m",
      "Act on each Argus terminal signal from the script output. Use the repo's argus-orchestrator skill; never implement worker tickets yourself.",
      "--name",
      "argus-signal-poll",
      "--script",
      "argus-signal-poll.sh",
      "--workdir",
      canonicalRepo,
    ]);
    expect(await Bun.file(script).text()).toBe(
      "#!/bin/sh\nexec '/opt/bun/bin/bun' '/opt/argus/src/cli.ts' signals --repo '" +
        `${canonicalRepo}'\n`,
    );
    expect((await lstat(script)).mode & 0o111).not.toBe(0);
  });

  test("fills only missing settings in an existing profile and repairs its memories directory", async () => {
    const { repo, root } = await scratchRepo("Existing Profile");
    const hermesRoot = join(root, "hermes");
    await mkdir(hermesRoot, { recursive: true });
    await Bun.write(join(hermesRoot, ".env"), "GLOBAL_ONLY=true\n");
    const options = {
      hermesRoot,
      honcho: new FakeHoncho(),
      honchoUrl: "http://honcho.test:8000",
      repo,
    };
    const initial = await convergeAgentBindings(options);
    const profile = join(hermesRoot, "profiles", initial.profile);
    await rm(join(profile, "memories"));
    await mkdir(join(profile, "memories"), { recursive: true });
    await Bun.write(
      join(profile, "config.yaml"),
      `model: custom/model
memory:
  memory_char_limit: 20000
curator:
  enabled: false
custom_setting: keep-me
`,
    );
    await Bun.write(join(profile, ".env"), "PROFILE_ONLY=true\n");

    await convergeAgentBindings(options);
    const afterFirst = await Bun.file(join(profile, "config.yaml")).text();
    await convergeAgentBindings(options);

    expect((await lstat(join(profile, "memories"))).isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(profile, ".env")).text()).toBe(
      "PROFILE_ONLY=true\n",
    );
    expect(afterFirst).toContain("memory_char_limit: 20000");
    expect(afterFirst).toContain("user_char_limit: 6000");
    expect(afterFirst).toContain("custom_setting: keep-me");
    expect(afterFirst.match(/user_char_limit:/g)).toHaveLength(1);
    expect(afterFirst.match(/enabled: false/g)).toHaveLength(1);
    expect(await Bun.file(join(profile, "config.yaml")).text()).toBe(afterFirst);
  });

  test("preserves memories from an existing profile before binding the directory", async () => {
    const { repo, root } = await scratchRepo("Profile Memories");
    const hermesRoot = join(root, "hermes");
    const options = {
      hermesRoot,
      honcho: new FakeHoncho(),
      honchoUrl: "http://honcho.test:8000",
      repo,
    };
    const initial = await convergeAgentBindings(options);
    const profileMemories = join(
      hermesRoot,
      "profiles",
      initial.profile,
      "memories",
    );
    await rm(profileMemories);
    await mkdir(profileMemories, { recursive: true });
    await Bun.write(join(profileMemories, "USER.md"), "Hermes knew this\n");
    await Bun.write(
      join(repo, ".argus", "memory", "MEMORY.md"),
      "Argus knew that\n",
    );

    await convergeAgentBindings(options);

    expect((await lstat(profileMemories)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(profileMemories, "USER.md")).text()).toBe(
      "Hermes knew this\n",
    );
    expect(await Bun.file(join(profileMemories, "MEMORY.md")).text()).toBe(
      "Argus knew that\n",
    );
    expect((await lstat(join(profileMemories, "USER.md"))).isSymbolicLink()).toBe(
      false,
    );
  });

  test("raises cloned default limits and disables an enabled native curator", async () => {
    const { repo, root } = await scratchRepo("Managed Safety");
    const hermesRoot = join(root, "hermes");
    await mkdir(hermesRoot, { recursive: true });
    await Bun.write(
      join(hermesRoot, "config.yaml"),
      `memory:
  memory_char_limit: 2200
  user_char_limit: 1375
curator:
  enabled: true
  interval_hours: 24
`,
    );

    const report = await convergeAgentBindings({
      hermesRoot,
      honcho: new FakeHoncho(),
      honchoUrl: "http://honcho.test:8000",
      repo,
    });

    expect(
      await Bun.file(
        join(hermesRoot, "profiles", report.profile, "config.yaml"),
      ).text(),
    ).toBe(
      `memory:
  memory_char_limit: 12000
  user_char_limit: 6000
curator:
  enabled: false
  interval_hours: 24
`,
    );
  });
});
