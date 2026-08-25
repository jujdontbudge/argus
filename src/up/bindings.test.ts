import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convergeAgentBindings,
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

    expect(first.honcho).toBe("created");
    expect(second.honcho).toBe("existing");
    expect(honcho.workspaces.get("argus-widget-kit")).toEqual({
      id: "argus-widget-kit",
      metadata: { repo },
    });
    expect([...honcho.peers.get("argus-widget-kit")!.values()]).toEqual([
      { id: "johan" },
      { configuration: { observe_me: false }, id: "claude-code" },
      { configuration: { observe_me: false }, id: "codex" },
      { configuration: { observe_me: false }, id: "hermes" },
    ]);
    expect(await Bun.file(join(repo, ".argus", "honcho.yaml")).text()).toBe(
      `url: http://honcho.test:8000
workspace: argus-widget-kit
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
  });
});
