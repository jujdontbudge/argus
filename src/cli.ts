#!/usr/bin/env bun

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
const STUB_COMMANDS = new Set(["up", "down", "status", "watch", "search"]);

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

  if (STUB_COMMANDS.has(args[0] ?? "")) {
    console.error(`argus ${args[0]}: not implemented yet`);
    return 1;
  }

  console.error(`argus: unknown command '${args[0]}'`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
