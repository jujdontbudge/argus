/**
 * Ticket #72 — the setup surface that the original ten §13 slots never touch.
 *
 * These are deliberately additive. The core ten keep their exact registrars,
 * manifests and pinned grades; setup gets its own five labelled scenarios and
 * is graded by the same STRUCTURAL/LIVE machinery.
 *
 * `createSandbox` performs the first production `argus up` synchronously in a
 * virgin scratch git repo. It supplies scratch HOME/Claude/Codex/Hermes paths
 * and a custom supervisor registry, which disables launchd control. That makes
 * the filesystem and command path real while leaving services, launchd and
 * agents out of the evidence. Every manifest therefore declares its doubles,
 * and none records live evidence.
 */
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandResult,
  Sandbox,
  ScenarioHandler,
  ScenarioReport,
} from "./index.ts";
import {
  gradeScenario,
  type LabeledScenarioManifest,
  type ScenarioGrade,
} from "./verdicts.ts";

export type InitUpScenarioId = "U0" | "U1" | "U2" | "U3" | "U4";

interface InitUpScenario {
  id: InitUpScenarioId;
  scenario: ScenarioHandler;
  title: string;
}

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

function envPath(sandbox: Sandbox, name: string): string {
  const value = sandbox.env[name];
  if (value === undefined) {
    throw new Error(`sandbox environment is missing ${name}`);
  }
  return value;
}

async function run(
  sandbox: Sandbox,
  cwd: string,
  command: readonly string[],
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...sandbox.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function runArgus(
  sandbox: Sandbox,
  command: "init" | "up",
  cwd = sandbox.repo,
): Promise<CommandResult> {
  return run(sandbox, cwd, [process.execPath, cli, command]);
}

async function gitOutput(
  sandbox: Sandbox,
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await run(sandbox, cwd, ["git", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

async function commitCount(sandbox: Sandbox, repo = sandbox.repo): Promise<number> {
  return Number.parseInt(
    await gitOutput(sandbox, repo, ["rev-list", "--count", "HEAD"]),
    10,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function snapshot(path: string): Promise<unknown> {
  if (!(await exists(path))) return { type: "missing" };
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    return { target: await readlink(path), type: "symlink" };
  }
  if (metadata.isDirectory()) {
    const entries = await readdir(path);
    entries.sort();
    return {
      entries: await Promise.all(
        entries.map(async (name) => [name, await snapshot(join(path, name))]),
      ),
      type: "directory",
    };
  }
  return {
    bytes: Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64"),
    type: "file",
  };
}

async function managedSetupSnapshot(sandbox: Sandbox): Promise<string> {
  const identity = (await Bun.file(
    join(sandbox.repo, ".argus", "identity.json"),
  ).json()) as { profile: string };
  const paths = [
    join(sandbox.repo, ".gitignore"),
    join(sandbox.repo, "AGENTS.md"),
    join(sandbox.repo, "docs", "agents"),
    join(sandbox.repo, ".argus", "config.yaml"),
    join(sandbox.repo, ".argus", "honcho.yaml"),
    join(sandbox.repo, ".argus", "identity.json"),
    join(sandbox.repo, ".argus", "memory"),
    join(sandbox.repo, ".claude", "settings.local.json"),
    join(sandbox.repo, ".claude", "skills"),
    join(envPath(sandbox, "CODEX_HOME"), "config.toml"),
    envPath(sandbox, "ARGUS_REPOS_FILE"),
    join(envPath(sandbox, "HERMES_HOME"), "profiles", identity.profile),
  ];
  return JSON.stringify(await Promise.all(paths.map(snapshot)));
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

async function uniqueManagedEntries(sandbox: Sandbox): Promise<boolean> {
  const [agents, ignore, claude, codex, registry] = await Promise.all([
    Bun.file(join(sandbox.repo, "AGENTS.md")).text(),
    Bun.file(join(sandbox.repo, ".gitignore")).text(),
    Bun.file(join(sandbox.repo, ".claude", "settings.local.json")).text(),
    Bun.file(join(envPath(sandbox, "CODEX_HOME"), "config.toml")).text(),
    Bun.file(envPath(sandbox, "ARGUS_REPOS_FILE")).text(),
  ]);
  const canonicalRepo = await realpath(sandbox.repo);
  return (
    occurrences(agents, "<!-- argus:begin -->") === 1 &&
    occurrences(agents, "<!-- argus:end -->") === 1 &&
    occurrences(agents, "<!-- matt-pocock:begin -->") === 1 &&
    occurrences(agents, "<!-- matt-pocock:end -->") === 1 &&
    occurrences(ignore, ".argus/\n") === 1 &&
    occurrences(ignore, ".claude/skills\n") === 1 &&
    occurrences(ignore, ".claude/settings.local.json\n") === 1 &&
    occurrences(claude, "ARGUS_HOOK=claude-stop") === 1 &&
    occurrences(codex, "# argus:notify:begin") === 1 &&
    occurrences(codex, "# argus:notify:end") === 1 &&
    occurrences(codex, "notify =") === 1 &&
    registry.split(/\r?\n/).filter((line) => line === canonicalRepo).length === 1
  );
}

async function hermesMemoryIsCanonical(sandbox: Sandbox): Promise<boolean> {
  const identity = (await Bun.file(
    join(sandbox.repo, ".argus", "identity.json"),
  ).json()) as { profile: string };
  const profileMemory = join(
    envPath(sandbox, "HERMES_HOME"),
    "profiles",
    identity.profile,
    "memories",
  );
  return (
    (await realpath(profileMemory)) ===
    (await realpath(join(sandbox.repo, ".argus", "memory")))
  );
}

async function createVirginRepo(sandbox: Sandbox, name: string): Promise<string> {
  const repo = join(sandbox.root, name);
  await mkdir(repo, { recursive: true });
  const initialized = await run(sandbox, repo, ["git", "init", "--quiet"]);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.trim());
  const committed = await run(sandbox, repo, [
    "git",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "virgin setup scenario",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr.trim());
  return repo;
}

const initRepoLocalScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  const repo = await createVirginRepo(sandbox, "init-virgin");
  const registryBefore = await Bun.file(
    envPath(sandbox, "ARGUS_REPOS_FILE"),
  ).text();
  const result = await runArgus(sandbox, "init", repo);

  assert(result.exitCode === 0, "init exits zero on a virgin repository");
  const layout = await Promise.all(
    ["registry", "memory", "skills", "sessions", "events"].map((directory) =>
      exists(join(repo, ".argus", directory)),
    ),
  );
  assert(
    layout.every(Boolean),
    "init creates the specified repo-local layout",
  );
  const [user, memory] = await Promise.all([
    Bun.file(join(repo, ".argus", "memory", "USER.md")).text(),
    Bun.file(join(repo, ".argus", "memory", "MEMORY.md")).text(),
  ]);
  assert(
    user.trim().length > 0 && memory.trim().length > 0,
    "init seeds the canonical memory pair",
  );
  assert(
    result.stdout.includes("wiring: claude skills adapter OK") &&
      result.stdout.includes("wiring: AGENTS.md pointers OK"),
    "init verifies the wiring it wrote",
  );
  assert(
    (await Bun.file(envPath(sandbox, "ARGUS_REPOS_FILE")).text()) ===
      registryBefore,
    "init does not enroll the considered repo with the supervisor",
  );
  assert(
    (await commitCount(sandbox, repo)) === 1,
    "init does not create a commit",
  );
};

const firstUpScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  assert(sandbox.up.exitCode === 0, "first up on a virgin repository exits zero");
  const layout = await Promise.all(
    ["registry", "memory", "skills", "sessions", "events"].map((directory) =>
      exists(join(sandbox.repo, ".argus", directory)),
    ),
  );
  let configParses = true;
  try {
    Bun.YAML.parse(
      await Bun.file(join(sandbox.repo, ".argus", "config.yaml")).text(),
    );
  } catch {
    configParses = false;
  }
  assert(
    layout.every(Boolean) && configParses,
    "first up creates the specified repo-local layout",
  );
  const [user, memory] = await Promise.all([
    Bun.file(join(sandbox.repo, ".argus", "memory", "USER.md")).text(),
    Bun.file(join(sandbox.repo, ".argus", "memory", "MEMORY.md")).text(),
  ]);
  assert(
    user.trim().length > 0 && memory.trim().length > 0,
    "first up seeds the canonical memory pair",
  );
  assert(
    await uniqueManagedEntries(sandbox),
    "first up installs native hooks and machine bindings exactly once",
  );
  assert(
    await hermesMemoryIsCanonical(sandbox),
    "first up binds Hermes memory to this repo's canonical pair",
  );
  assert(
    sandbox.up.stdout.includes(
      "cmux hooks: optional (resume convenience; not required for signal delivery)",
    ),
    "cmux hooks are reported as optional and never gate convergence",
  );
  assert(
    (await commitCount(sandbox)) === 1,
    "first up does not create a commit",
  );
};

const secondUpScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  const before = await managedSetupSnapshot(sandbox);
  const result = await runArgus(sandbox, "up");
  const after = await managedSetupSnapshot(sandbox);

  assert(result.exitCode === 0, "second up exits zero");
  assert(after === before, "second up leaves managed setup state byte-identical");
  assert(
    await uniqueManagedEntries(sandbox),
    "second up leaves exactly one copy of every managed hook and pointer",
  );
  assert((await commitCount(sandbox)) === 1, "second up does not create a commit");
};

const editedMemoryScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  const userPath = join(sandbox.repo, ".argus", "memory", "USER.md");
  const memoryPath = join(sandbox.repo, ".argus", "memory", "MEMORY.md");
  const userEdit = "# USER.md\n\nJohan keeps this hand-written preference.\n";
  const memoryEdit = "# Memory index\n\n- [hand-written fact](hand-written.md)\n";
  await Promise.all([
    Bun.write(userPath, userEdit),
    Bun.write(memoryPath, memoryEdit),
    Bun.write(
      join(sandbox.repo, ".argus", "memory", "hand-written.md"),
      "# Hand-written fact\n\nNever replace user-owned memory during convergence.\n",
    ),
  ]);

  const result = await runArgus(sandbox, "up");
  assert(
    result.exitCode === 0,
    "up over an existing .argus directory exits zero",
  );
  assert(
    (await Bun.file(userPath).text()) === userEdit &&
      (await Bun.file(memoryPath).text()) === memoryEdit &&
      (await Bun.file(
        join(sandbox.repo, ".argus", "memory", "hand-written.md"),
      ).text()).includes("Never replace"),
    "up preserves user-edited canonical memory byte-for-byte",
  );
  assert(
    await hermesMemoryIsCanonical(sandbox),
    "edited memory remains the pair Hermes is bound to",
  );
  assert(
    (await commitCount(sandbox)) === 1,
    "up over edited memory creates no commit",
  );
};

const trackerLessScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  assert(
    (await gitOutput(sandbox, sandbox.repo, ["remote"])) === "",
    "tracker-less scenario has no git remote",
  );
  assert(sandbox.up.exitCode === 0, "up without a git remote exits zero");
  assert(
    sandbox.up.stderr.includes(
      "TRACKER-LESS MODE: no GitHub remote; skipped GitHub labels and tracker checks",
    ),
    "up reports tracker-less mode instead of silently skipping the tracker",
  );
  assert(
    (await uniqueManagedEntries(sandbox)) &&
      (await hermesMemoryIsCanonical(sandbox)),
    "tracker-less up still converges local hooks and machine bindings",
  );
  assert(
    (await commitCount(sandbox)) === 1,
    "tracker-less up does not create a commit",
  );
};

export const INIT_UP_SCENARIOS: readonly InitUpScenario[] = [
  { id: "U0", scenario: initRepoLocalScenario, title: "Repo-local init" },
  { id: "U1", scenario: firstUpScenario, title: "First up on a virgin repo" },
  { id: "U2", scenario: secondUpScenario, title: "Second up converges" },
  { id: "U3", scenario: editedMemoryScenario, title: "Up preserves edited memory" },
  { id: "U4", scenario: trackerLessScenario, title: "Tracker-less up" },
] as const;

/**
 * Quotes come from the setup-relevant SPEC text, not the implementation.
 * Empty assertion lists are intentional gaps, exactly as in #63's core
 * manifests. In particular, scratch registries disable launchd, so the suite
 * cannot honestly claim that `up` started the eyes.
 */
export const INIT_UP_MANIFESTS: Readonly<
  Record<InitUpScenarioId, LabeledScenarioManifest>
> = {
  U0: {
    doubles: ["agent", "supervisor"],
    number: "U0",
    title: "Repo-local init",
    requirements: [
      {
        assertions: [
          "init creates the specified repo-local layout",
          "init seeds the canonical memory pair",
        ],
        id: "10.init.idempotent-scaffold",
        shortfall: "the scenario runs once; repeated convergence is graded by U2",
        spec:
          "idempotently scaffold `.argus/`, gitignore it, seed the canonical `.argus/memory/USER.md` + `MEMORY.md` pair",
      },
      {
        assertions: [],
        id: "10.init.repo-only-boundary",
        shortfall:
          "the structural harness isolates all machine paths but does not prove the no-network/no-process boundary, and the Claude memory adapter still needs a dedicated boundary assertion",
        spec: "It contacts no network and writes nothing outside the repo",
      },
      {
        assertions: ["init does not enroll the considered repo with the supervisor"],
        id: "10.init.no-machine-convergence",
        shortfall:
          "only supervisor enrollment is observed; Honcho, Hermes and process absence are not independently instrumented",
        spec:
          "no `~/.codex`, no `~/.hermes`, no supervisor registry, no launchd, no started process",
      },
      {
        assertions: ["init verifies the wiring it wrote"],
        id: "10.init.verify",
        shortfall: "",
        spec: "It finishes by VERIFYING the wiring it wrote",
      },
      {
        assertions: ["init does not create a commit"],
        id: "10.init.no-default-commit",
        shortfall: "",
        spec: "Neither command commits on your behalf by default.",
      },
    ],
  },
  U1: {
    doubles: ["agent", "supervisor"],
    number: "U1",
    title: "First up on a virgin repo",
    requirements: [
      {
        assertions: [
          "first up on a virgin repository exits zero",
          "first up creates the specified repo-local layout",
          "first up seeds the canonical memory pair",
        ],
        id: "10.up.init-first",
        shortfall: "",
        spec: "`argus up` — `argus init` followed by machine convergence",
      },
      {
        assertions: [
          "first up installs native hooks and machine bindings exactly once",
        ],
        id: "3.up.native-push-hooks",
        shortfall:
          "the files are read back, but no live Claude or Codex session fires them",
        spec:
          "`argus up` installs a Claude Code `Stop` hook and a Codex `notify` command itself",
      },
      {
        assertions: [
          "cmux hooks are reported as optional and never gate convergence",
        ],
        id: "3.up.cmux-optional",
        shortfall:
          "the installed cmux capability is reported, but no resume hook is exercised",
        spec: "Setup must never block on them.",
      },
      {
        assertions: [
          "cmux hooks are reported as optional and never gate convergence",
        ],
        id: "11.6.up.cmux-optional",
        shortfall:
          "the 0.62.2 absent-without-consequence path is observed; the optional setup path on cmux 0.64.22 or newer is not exercised",
        spec:
          "`cmux hooks setup` + `cmux hooks setup codex` on cmux ≥ 0.64.22, for resume convenience only",
      },
      {
        assertions: ["first up binds Hermes memory to this repo's canonical pair"],
        id: "11.8.up.hermes-memory-binding",
        shortfall:
          "the scratch profile symlink is real, but no live Hermes memory flush runs",
        spec:
          "redirect Hermes' native memory flush to the active repo's `.argus/memory/` pair",
      },
      {
        assertions: [],
        id: "10.up.start-eyes",
        shortfall:
          "the harness custom registry deliberately disables launchd control, so no supervisor or eye process starts",
        spec: "start this repo's eyes",
      },
      {
        assertions: ["first up does not create a commit"],
        id: "10.up.no-default-commit",
        shortfall: "",
        spec: "Neither command commits on your behalf by default.",
      },
    ],
  },
  U2: {
    doubles: ["agent", "supervisor"],
    number: "U2",
    title: "Second up converges",
    requirements: [
      {
        assertions: [
          "second up exits zero",
          "second up leaves managed setup state byte-identical",
          "second up leaves exactly one copy of every managed hook and pointer",
        ],
        id: "10.up.machine-convergence",
        shortfall:
          "Honcho is degraded and launchd is disabled, so service-side convergence is not observed here",
        spec: "`argus init` followed by machine convergence",
      },
      {
        assertions: ["second up does not create a commit"],
        id: "10.up.second-no-default-commit",
        shortfall: "",
        spec: "Neither command commits on your behalf by default.",
      },
    ],
  },
  U3: {
    doubles: ["agent", "supervisor"],
    number: "U3",
    title: "Up preserves edited memory",
    requirements: [
      {
        assertions: ["up preserves user-edited canonical memory byte-for-byte"],
        id: "10.up.preserve-memory",
        shortfall:
          "the edit is planted by the scenario, not written by a live Reviewer or Claude session",
        spec: "idempotently scaffold `.argus/`",
      },
      {
        assertions: ["edited memory remains the pair Hermes is bound to"],
        id: "11.8.up.edited-hermes-binding",
        shortfall:
          "the scratch profile symlink is real, but no live Hermes memory flush runs",
        spec: "the active repo's `.argus/memory/` pair",
      },
      {
        assertions: ["up over edited memory creates no commit"],
        id: "10.up.edited-no-default-commit",
        shortfall: "",
        spec: "Neither command commits on your behalf by default.",
      },
    ],
  },
  U4: {
    doubles: ["agent", "supervisor"],
    number: "U4",
    title: "Tracker-less up",
    requirements: [
      {
        assertions: [
          "tracker-less scenario has no git remote",
          "up without a git remote exits zero",
          "up reports tracker-less mode instead of silently skipping the tracker",
        ],
        id: "10.up.tracker-labels",
        shortfall:
          "the SPEC requires tracker-label convergence but does not define the no-remote fallback; this assertion pins #73's observed tracker-less behavior rather than upgrading the SPEC claim",
        spec: "create tracker labels (`retro`, wayfinder set)",
      },
      {
        assertions: [
          "tracker-less up still converges local hooks and machine bindings",
        ],
        id: "10.up.trackerless-local-convergence",
        shortfall: "Honcho is degraded and launchd is disabled in the structural harness",
        spec: "`argus init` followed by machine convergence",
      },
      {
        assertions: ["tracker-less up does not create a commit"],
        id: "10.up.trackerless-no-default-commit",
        shortfall: "",
        spec: "Neither command commits on your behalf by default.",
      },
    ],
  },
};

export function gradeInitUpScenarios(
  reports: ReadonlyMap<
    InitUpScenarioId,
    Pick<ScenarioReport, "assertions" | "liveEvidence" | "status">
  >,
): ScenarioGrade[] {
  return INIT_UP_SCENARIOS.flatMap(({ id }) => {
    const report = reports.get(id);
    return report === undefined
      ? []
      : [gradeScenario(INIT_UP_MANIFESTS[id], report)];
  });
}
