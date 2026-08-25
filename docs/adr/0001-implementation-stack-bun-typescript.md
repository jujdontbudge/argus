---
status: accepted
---

# Implementation stack: Bun + TypeScript, run-from-checkout

The `argus` CLI, all five watchers, and the shared transcript-tailing library are one
Bun + TypeScript codebase, and the git checkout of this repo IS the installation.
Decided in the ticket #14 grilling session with Johan (2026-08-24): the system is 90%
subprocess-and-file glue, and Bun's stable built-ins cover both hard requirements with
zero runtime dependencies — `bun:sqlite` (FTS5, verified) for `archive.db` and
read-only WAL-safe polling of Hermes `state.db`, and `Bun.zstdDecompressSync` for
Codex rollout eras.

## Shape

- One `argus` executable with subcommands; each of the five watchers stays an
  independent launchd-supervised process, launched as `argus watch <eye> --repo <path>`
  from a plist templated over `{eye, repo}`.
- Bootstrap: clone, then `bun <checkout>/src/cli.ts install` once — verifies the Bun
  floor and symlinks `~/.local/bin/argus` to the checkout's launcher. No Makefile, no
  build artifacts, no publish step. Upgrade = `git pull` + `argus up`.
- `argus up` is an idempotent converger (scaffold, adapters, Honcho binding, labels,
  supervisor enrollment, watcher kickstart — safe to re-run always) and is the command
  agents are handed, attached as a SKILL.md via the normal `.argus/skills/` adapters.
  Layering: the command does enrollment + immediate start; launchd does login
  persistence + crash restart (SPEC §9 intact). Hooks-based silent auto-converge is
  deliberately deferred.
- Preconditions: `argus up` refuses non-git directories; a repo with no GitHub remote
  runs in loud tracker-less mode (ticket/retro filing degrades to digest-only,
  everything else watches normally).
- Bun version floats above a hard floor checked at startup; no version manager.

## Considered options

- **Node 22 + TS** — rejected: `node:sqlite` still flagged-experimental on 22.x, so
  it would mean a native-compile dependency (better-sqlite3) or a runtime upgrade.
- **Python + uv** — rejected: the machine's python is anaconda's (the same
  env-fragility class that killed the Hermes install, ticket #2), zstd is a dep, and
  per-process startup/memory is worst of the candidates.
- **Go** — the strongest alternative (ideal launchd daemons), rejected: SQLite needs
  cgo or a heavy pure-Go driver, and the glue/harness work iterates slower for
  agent-built code.
- **Built-artifact install** — rejected: adds a build/version-skew layer to a
  single-user, single-machine tool.

## Consequences

- Dependency policy is lean-by-default: runtime built-ins first; any dependency needs
  stated justification in its ticket. `typescript` is the one sanctioned dev-only dep.
- Every build ticket is gated by strict `tsc --noEmit` + `bun test` (Bun executes TS
  without type-checking it); the §13 fake-Johan harness scenarios ride `bun test`.
- Accepted trade-offs: ~30–50MB RSS per watcher process at current repo counts;
  Bun-version drift above the floor is Johan's to manage; no dev/prod separation
  beyond the §13 sandbox repo — editing the checkout mutates the live system.
