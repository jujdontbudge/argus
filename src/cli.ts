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

export async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return 0;
  }

  console.error(`argus: unknown command '${args[0]}'`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
