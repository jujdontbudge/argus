import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

export interface HonchoWorkspaceInput {
  id: string;
  metadata: { repo: string };
}

export interface HonchoPeerInput {
  configuration?: { observe_me: false };
  id: "johan" | "claude-code" | "codex" | "hermes";
}

export interface HonchoClient {
  ensureWorkspace(
    input: HonchoWorkspaceInput,
  ): Promise<"created" | "existing">;
  ensurePeer(
    workspace: string,
    input: HonchoPeerInput,
  ): Promise<"created" | "existing">;
}

export interface AgentBindingOptions {
  hermesRoot: string;
  honcho: HonchoClient;
  honchoUrl: string;
  repo: string;
}

export interface AgentBindingReport {
  honcho: "created" | "existing";
  profile: string;
  workspace: string;
}

const PEERS: readonly HonchoPeerInput[] = [
  { id: "johan" },
  { configuration: { observe_me: false }, id: "claude-code" },
  { configuration: { observe_me: false }, id: "codex" },
  { configuration: { observe_me: false }, id: "hermes" },
];

function repoSlug(repo: string): string {
  return basename(repo)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function honchoBinding(url: string, workspace: string): string {
  return `url: ${url}
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
`;
}

export async function convergeAgentBindings(
  options: AgentBindingOptions,
): Promise<AgentBindingReport> {
  const workspace = `argus-${repoSlug(options.repo)}`;
  await mkdir(join(options.repo, ".argus"), { recursive: true });
  await Bun.write(
    join(options.repo, ".argus", "honcho.yaml"),
    honchoBinding(options.honchoUrl, workspace),
  );

  const honcho = await options.honcho.ensureWorkspace({
    id: workspace,
    metadata: { repo: options.repo },
  });
  for (const peer of PEERS) {
    await options.honcho.ensurePeer(workspace, peer);
  }

  return { honcho, profile: workspace, workspace };
}
