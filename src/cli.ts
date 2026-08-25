#!/usr/bin/env bun

import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Argus — orchestration and self-learning toolkit

Usage: argus <command>

Commands:
  up       converge and start this repo's eyes
  down     stop this repo's eyes
  status   inspect this repo's eyes
  watch    run one eye
  search   search the transcript archive
  install  install argus from this checkout
`;

export const MINIMUM_BUN_VERSION = "1.3.12";

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split("-", 1)[0]?.split(".").map(Number) ?? [];
  const minimumParts = minimum.split(".").map(Number);

  if (actualParts.length < 3 || actualParts.some(Number.isNaN)) {
    return false;
  }

  for (let index = 0; index < minimumParts.length; index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }

  return true;
}

async function install(): Promise<number> {
  const home = process.env.HOME;
  if (!home) {
    console.error("argus install: HOME is not set");
    return 1;
  }

  const binDirectory = join(home, ".local", "bin");
  const launcher = join(binDirectory, "argus");
  const cli = fileURLToPath(import.meta.url);
  const checkout = dirname(dirname(cli));

  try {
    await lstat(join(checkout, ".git"));
  } catch {
    console.error("argus install must run from a git checkout of Argus");
    return 1;
  }

  await mkdir(binDirectory, { recursive: true });
  try {
    const existingTarget = await readlink(launcher);
    if (existingTarget === cli) {
      console.log(`Argus is already installed at ${launcher}`);
      return 0;
    }

    console.error(
      `argus install: ${launcher} already points to ${existingTarget}; refusing to replace it`,
    );
    return 1;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  await symlink(cli, launcher);
  console.log(`Installed argus at ${launcher}`);
  return 0;
}

async function search(args: string[]): Promise<number> {
  const query = args.join(" ").trim();
  if (query.length === 0) {
    console.error('Usage: argus search "<query>"');
    return 1;
  }

  const { gitRoot } = await import("./up/git.ts");
  const repo = await gitRoot(process.cwd());
  if (repo === null) {
    console.error("argus search: current directory is not inside a git repository");
    return 1;
  }
  if (!(await Bun.file(join(repo, ".argus/archive.db")).exists())) {
    console.error(`argus search: no archive exists for ${repo}`);
    return 1;
  }

  const { openArchiveSearch } = await import("./search/index.ts");
  const archive = openArchiveSearch({ repo });
  try {
    const results = archive.query(query);
    if (results.length === 0) {
      console.log(`No archived messages matched "${query}".`);
      return 0;
    }
    for (const result of results) {
      const attribution = [
        result.ts,
        `session=${result.sessionId}`,
        `agent=${result.agent ?? "unknown"}`,
        `role=${result.role}`,
        `provenance=${result.provenance}`,
        ...(result.ticket !== null ? [`ticket=#${result.ticket}`] : []),
      ].join("  ");
      console.log(attribution);
      console.log(`  ${result.snippet}`);
    }
    return 0;
  } finally {
    archive.close();
  }
}

export async function main(args: string[]): Promise<number> {
  const bunVersion = process.versions.bun;
  if (!bunVersion || !isVersionAtLeast(bunVersion, MINIMUM_BUN_VERSION)) {
    console.error(
      `argus requires Bun >= ${MINIMUM_BUN_VERSION}; found ${bunVersion ?? "unknown"}`,
    );
    return 1;
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return 0;
  }

  if (args[0] === "up") {
    const { convergeUp } = await import("./up.ts");
    return convergeUp();
  }

  if (args[0] === "down") {
    const { down } = await import("./supervisor/commands.ts");
    return down();
  }

  if (args[0] === "status") {
    const { status } = await import("./supervisor/commands.ts");
    return status();
  }

  if (args[0] === "supervisor") {
    const { runSupervisorDaemon } = await import("./supervisor/daemon.ts");
    return runSupervisorDaemon();
  }

  if (args[0] === "search") {
    return search(args.slice(1));
  }

  if (args[0] === "watch") {
    const { runWatcher } = await import("./watch.ts");
    return runWatcher(args.slice(1));
  }

  if (args[0] === "install") {
    return install();
  }

  console.error(`argus: unknown command '${args[0]}'`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
