import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  convergeAgentBindings,
  HttpHonchoClient,
  type HonchoClient,
} from "./up/bindings.ts";
import { gitRoot } from "./up/git.ts";
import { convergePushHooks } from "./up/hooks.ts";
import {
  githubRepo,
  reportCommitState,
  run,
  scaffoldRepo,
} from "./up/scaffold.ts";
import { printWiring, verifyWiring } from "./up/verify.ts";
import { startSupervisor } from "./supervisor/control.ts";
import { enableRepo } from "./supervisor/registry.ts";

const DEFAULT_HONCHO_URL = "http://localhost:8000";

const TRACKER_LABELS = [
  {
    color: "5319E7",
    description: "Retrospective work discovered after the original task",
    name: "retro",
  },
  {
    color: "0E8A16",
    description: "Wayfinder destination map",
    name: "wayfinder:map",
  },
  {
    color: "1D76DB",
    description: "Wayfinder research ticket",
    name: "wayfinder:research",
  },
  {
    color: "FBCA04",
    description: "Wayfinder prototype ticket",
    name: "wayfinder:prototype",
  },
  {
    color: "D93F0B",
    description: "Wayfinder human decision ticket",
    name: "wayfinder:grilling",
  },
  {
    color: "0052CC",
    description: "Wayfinder implementation task",
    name: "wayfinder:task",
  },
] as const;

function configuredHonchoUrl(config: string): string {
  const lines = config.split(/\r?\n/);
  const section = lines.findIndex((line) => /^honcho:\s*(?:#.*)?$/.test(line));
  if (section === -1) return DEFAULT_HONCHO_URL;
  for (let index = section + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s+url:\s*(.*?)\s*$/);
    if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, "");
  }
  return DEFAULT_HONCHO_URL;
}

async function honchoApiKey(home: string): Promise<string | null> {
  const fromEnvironment = process.env.HONCHO_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const configPath =
    process.env.HONCHO_CONFIG_FILE ?? join(home, ".honcho", "config.json");
  try {
    const config = (await Bun.file(configPath).json()) as { apiKey?: unknown };
    return typeof config.apiKey === "string" && config.apiKey.trim().length > 0
      ? config.apiKey.trim()
      : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `argus up: could not read Honcho credentials at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function unavailableHoncho(reason: string): HonchoClient {
  return {
    ensurePeer: async () => {
      throw new Error(reason);
    },
    ensureWorkspace: async () => {
      throw new Error(reason);
    },
  };
}

async function ensureTracker(repo: string): Promise<void> {
  const remoteRepo = await githubRepo(repo);
  if (!remoteRepo) {
    console.error(
      "TRACKER-LESS MODE: no GitHub remote; skipped GitHub labels and tracker checks",
    );
    return;
  }

  const verified = await run(
    ["gh", "repo", "view", remoteRepo, "--json", "nameWithOwner"],
    repo,
  );
  if (verified.exitCode !== 0) {
    console.error(
      `TRACKER-LESS MODE: gh could not access ${remoteRepo}; skipped GitHub labels and tracker checks`,
    );
    return;
  }

  const listed = await run(
    [
      "gh",
      "label",
      "list",
      "--repo",
      remoteRepo,
      "--limit",
      "100",
      "--json",
      "name",
    ],
    repo,
  );
  if (listed.exitCode !== 0) {
    console.error(
      `TRACKER-LESS MODE: gh could not list labels for ${remoteRepo}; skipped label convergence`,
    );
    return;
  }

  const existing = new Set(
    (JSON.parse(listed.stdout) as Array<{ name: string }>).map(({ name }) => name),
  );
  for (const label of TRACKER_LABELS) {
    if (existing.has(label.name)) continue;
    const created = await run(
      [
        "gh",
        "label",
        "create",
        label.name,
        "--repo",
        remoteRepo,
        "--color",
        label.color,
        "--description",
        label.description,
      ],
      repo,
    );
    if (created.exitCode !== 0) {
      console.error(
        `TRACKER-LESS MODE: gh could not create '${label.name}' for ${remoteRepo}; tracker convergence incomplete`,
      );
      return;
    }
  }
  console.log(`GitHub tracker: ${remoteRepo}`);
}

async function ensureSupervisorEnrollment(repo: string): Promise<void> {
  const home = process.env.HOME;
  const registry =
    process.env.ARGUS_REPOS_FILE ?? (home ? join(home, ".argus-repos") : null);
  if (!registry) throw new Error("argus up: HOME is not set");

  await enableRepo(registry, repo);
}


/**
 * Report what cmux can actually do, rather than what a stale TODO said.
 *
 * #7 is closed and cmux hooks are OPTIONAL (SPEC §3/§11.6): the required push
 * path is the native Claude `Stop` hook plus the Codex `notify` command, which
 * `up` installs itself and which involve no cmux at all. This machine is
 * permanently 0.62.2, where `cmux hooks` does not exist — so the honest line
 * is a capability report, never a pending item, and it never gates anything.
 */
async function reportCmuxCapability(repo: string): Promise<void> {
  console.log(
    "cmux hooks: optional (resume convenience; not required for signal delivery)",
  );
  const probe = await run(["cmux", "--version"], repo);
  if (probe.exitCode !== 0) {
    console.log(
      "  cmux not installed — the Claude Stop + Codex notify path above needs nothing from it",
    );
    return;
  }
  const version = probe.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
  const parts = version.split(".").map(Number);
  const supported =
    parts.length === 3 &&
    !parts.some(Number.isNaN) &&
    (parts[0]! > 0 ||
      parts[1]! > 64 ||
      (parts[1]! === 64 && parts[2]! >= 22));
  console.log(
    supported
      ? `  cmux ${version} supports \`cmux hooks setup\` as an optional extra`
      : `  cmux ${version} has no \`hooks\` command — nothing in Argus requires one`,
  );
}

export interface SetupOptions {
  /**
   * Commit the integration files Argus wrote. Off by default: committing on a
   * user's behalf is the surprising part, so it is opt-in and always printed.
   */
  commit?: boolean;
}

/**
 * `argus init` — make this a repo Argus understands, and nothing more.
 *
 * Repo-local only: no network, no `~/.codex`/`~/.hermes`/launchd, no started
 * processes. That is the whole contract, and it is what makes `init` safe to
 * run on a repo you are only considering adopting. `argus up` runs all of this
 * first and then converges the machine.
 */
export async function initRepo(
  cwd = process.cwd(),
  options: SetupOptions = {},
): Promise<number> {
  const repo = await gitRoot(cwd);
  if (!repo) {
    console.error("argus init: current directory is not inside a git repository");
    return 1;
  }

  const scaffold = await scaffoldRepo(repo);
  console.log(`Argus repo scaffold: ${repo}`);
  console.log("  .argus/            layout, config.yaml, canonical memory and skills");
  if (scaffold.seededMemory.length > 0) {
    console.log(`  .argus/memory/     seeded ${scaffold.seededMemory.join(", ")}`);
  }
  console.log(
    scaffold.skillsLayout === "preserved"
      ? "  .claude/skills     preserved in place; Argus skills stay under .argus/skills"
      : "  .claude/skills     -> ../.argus/skills",
  );
  console.log("  AGENTS.md          argus + matt-pocock pointer blocks");
  console.log("  docs/agents/       issue-tracker.md, triage-labels.md, domain.md");

  const wired = printWiring(await verifyWiring(repo));
  await reportCommitState(repo, "init", options.commit === true);
  console.log("Run `argus up` to converge machine wiring and start this repo's eyes.");
  return wired ? 0 : 1;
}

/**
 * `argus up` — `init` plus machine convergence, then start the eyes.
 *
 * Still a converger: every step below either matches what it finds or rewrites
 * it to the same bytes, so a second run enrols nothing twice, re-seeds no
 * memory, and creates no commit.
 */
export async function convergeUp(
  cwd = process.cwd(),
  options: SetupOptions = {},
): Promise<number> {
  const repo = await gitRoot(cwd);
  if (!repo) {
    console.error("argus up: current directory is not inside a git repository");
    return 1;
  }

  const scaffold = await scaffoldRepo(repo);
  if (scaffold.seededMemory.length > 0) {
    console.log(`Seeded .argus/memory/: ${scaffold.seededMemory.join(", ")}`);
  }

  const home = process.env.HOME;
  if (!home) throw new Error("argus up: HOME is not set");
  await convergePushHooks({
    codexHome: process.env.CODEX_HOME ?? join(home, ".codex"),
    repo,
  });
  await ensureSupervisorEnrollment(repo);
  await startSupervisor();
  await ensureTracker(repo);

  const config = Bun.file(join(repo, ".argus", "config.yaml"));
  const url = configuredHonchoUrl(await config.text());
  const apiKey = await honchoApiKey(home);
  const hermesRoot = process.env.HERMES_HOME ?? join(home, ".hermes");
  const bindings = await convergeAgentBindings({
    argusCli: join(dirname(fileURLToPath(import.meta.url)), "cli.ts"),
    bunExecutable: process.execPath,
    hermesRoot,
    honcho: apiKey
      ? new HttpHonchoClient(url, apiKey)
      : unavailableHoncho(
          "HONCHO_API_KEY and ~/.honcho/config.json apiKey are both missing",
        ),
    honchoUrl: url,
    repo,
    skillDirectories:
      scaffold.skillsLayout === "preserved"
        ? [join(repo, ".claude", "skills"), join(repo, ".argus", "skills")]
        : [join(repo, ".argus", "skills")],
  });
  if (bindings.honcho === "unavailable") {
    console.error(
      `HONCHO DEGRADED: ${url} unavailable (${bindings.honchoError}); local bindings converged`,
    );
  } else {
    console.log(`Honcho binding: ${bindings.workspace} (${bindings.honcho})`);
  }
  if (bindings.cron === "unavailable") {
    console.error(`HERMES POLL DEGRADED: ${bindings.cronError}`);
  } else {
    console.log(`Hermes slow poll: ${bindings.cron} (every 5m)`);
  }
  console.log(`Hermes profile: ${bindings.profile}`);
  console.log("Push hooks: Claude Stop + Codex notify");
  await reportCmuxCapability(repo);

  // Read back what every reader will actually read, through the adapters they
  // will actually use. Writing the pointer is not evidence the pointer works.
  const wired = printWiring(
    await verifyWiring(repo, {
      hermes: { profile: bindings.profile, root: hermesRoot },
    }),
  );
  await reportCommitState(repo, "up", options.commit === true);
  console.log(`Argus converged ${repo}`);
  return wired ? 0 : 1;
}
