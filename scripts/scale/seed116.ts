/**
 * Build #116's multi-repo scratch world: ONE scratch HOME, N sandbox repos.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE HOME AND NOT N HOMES, WHICH IS A DEVIATION FROM THE TICKET'S WORDING
 * ---------------------------------------------------------------------------
 * #116 asks for "N separate sandbox repos under separate scratch HOMEs, each
 * enrolled with its own 5-eye watcher fleet under ONE supervisor process". Those
 * two halves cannot both hold, and the ticket anticipated that this is the kind
 * of thing to establish rather than assume:
 *
 *   - `supervisorConfiguration` (src/supervisor/control.ts:137-196) reads ONE
 *     `HOME` and derives ONE `claudeConfigPath`, `codexHomePath` and
 *     `hermesHomePath` from it, for the whole supervisor.
 *   - `createWatcherSpawner` (src/supervisor/daemon.ts:9-33) passes that single
 *     env to EVERY child, and `runSupervisorDaemon` never overrides it per repo.
 *     The only per-repo argument a watcher gets is `--repo`.
 *
 * So one supervisor is one HOME, by construction. N HOMEs would need N
 * supervisors, which is not the topology under test.
 *
 * This is not a workaround, it is the harder and more honest case. Johan has
 * one `~/.claude` and many repos; that IS production. And separate HOMEs would
 * make cross-repo isolation trivially true by filesystem partition, testing
 * nothing. Under one HOME every watcher scans every repo's transcripts and the
 * only thing keeping them apart is `sessionsForRepo`'s content filter
 * (src/eyes/source.ts:26). That filter is what #116 calls its most important
 * correctness property, and this is the world that actually exercises it.
 *
 * ---------------------------------------------------------------------------
 * SEED SIZE, WHICH MOVES WITH N AND HAD TO
 * ---------------------------------------------------------------------------
 * `scripts/soak/seed.ts` seeds ~5 MiB and its docblock records why: at 23 MiB
 * the first `catchUp` pushed digest to 619 MiB and tripped the 512 MiB ceiling,
 * scoring a seeding artefact as a ceiling failure.
 *
 * Under one HOME that budget is per-FLEET, not per-repo. `listFiles()` returns
 * every transcript in the shared tree to every watcher, which then parses them
 * all and discards the foreign ones. So a watcher's cold-start read is
 * N x per-repo-seed, and #105's 5 MiB per watcher becomes 15 MiB at N=3 if the
 * per-repo number is left alone.
 *
 * Per-repo seed is therefore ~2 MiB, so the FLEET-VISIBLE total at N=3 is ~6
 * MiB — within a MiB of the per-watcher figure #105 established as safe. The
 * quantity held constant across tickets is the one the ceiling actually sees.
 *
 * The vocabulary and message shape are otherwise #105's unchanged, with ONE
 * addition: every line carries a `marker<i>` token unique to its repo. That
 * token is the leakage detector — a `marker1` row inside repo 0's archive is
 * cross-repo leakage stated as a fact rather than inferred from a count.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
const repoCount = Number(process.argv[3] ?? 3);
if (!root) throw new Error("usage: seed116.ts <scratch-root> [repo-count]");
if (!Number.isSafeInteger(repoCount) || repoCount < 1) {
  throw new Error(`repo-count must be a positive integer, got ${process.argv[3]}`);
}

const home = join(root, "home");
const codexSessions = join(home, ".codex", "sessions", "2026", "08", "28");
const claudeProjects = join(home, ".claude", "projects");

/** ~2 MiB per repo; see the docblock on why this moved down from #105's ~5. */
const CODEX_FILES = Number(process.env.ARGUS_SCALE_CODEX_FILES ?? 4);
const CODEX_BYTES_PER_FILE = Number(process.env.ARGUS_SCALE_CODEX_BYTES ?? 384 * 1024);
const CLAUDE_FILES = Number(process.env.ARGUS_SCALE_CLAUDE_FILES ?? 2);
const CLAUDE_BYTES_PER_FILE = Number(process.env.ARGUS_SCALE_CLAUDE_BYTES ?? 256 * 1024);

export function repoPath(scratchRoot: string, index: number): string {
  return join(scratchRoot, `repo-${index}`);
}

/** #105's vocabulary verbatim: the FTS corpus shape has to stay comparable. */
function filler(seed: number, words: number): string {
  const vocabulary = [
    "argus", "watcher", "rollout", "cursor", "provenance", "archiver",
    "digest", "retro", "honcho", "reviewer", "transcript", "soak",
    "ceiling", "supervisor", "backlog", "session", "ingest", "sqlite",
  ];
  const out: string[] = [];
  let state = seed >>> 0;
  for (let index = 0; index < words; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    out.push(vocabulary[state % vocabulary.length]!);
  }
  return out.join(" ");
}

/** Distinct per repo AND per file, so no two repos can collide on a session id. */
function codexSessionId(repo: number, index: number): string {
  return `00000000-0000-0000-${String(1160 + repo).padStart(4, "0")}-${String(
    116000 + index,
  ).padStart(12, "0")}`;
}

function codexLines(repo: number, index: number, cwd: string, bytes: number): string {
  const id = codexSessionId(repo, index);
  const rows: string[] = [
    JSON.stringify({
      timestamp: "2026-08-28T00:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        cwd,
        cli_version: "0.149.0",
        history_mode: "paginated",
        thread_source: "cli",
        context_window: 272000,
      },
    }),
  ];
  let size = rows[0]!.length + 1;
  let ordinal = 1;
  while (size < bytes) {
    const role = ordinal % 2 === 1 ? "user" : "assistant";
    const line = JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 7, 28, 0, 0, 0) + ordinal * 1000).toISOString(),
      ordinal,
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text: `marker${repo} seed ${index}.${ordinal} ${filler(
              repo * 1000003 + index * 100003 + ordinal,
              40,
            )}`,
          },
        ],
      },
    });
    rows.push(line);
    size += line.length + 1;
    ordinal += 1;
  }
  return `${rows.join("\n")}\n`;
}

function claudeLines(repo: number, index: number, cwd: string, bytes: number): string {
  const session = `scale116-r${repo}-claude-${index}`;
  const rows: string[] = [];
  let size = 0;
  let ordinal = 0;
  while (size < bytes) {
    const user = ordinal % 2 === 0;
    const timestamp = new Date(
      Date.UTC(2026, 7, 28, 0, 0, 0) + ordinal * 1000,
    ).toISOString();
    const text = `marker${repo} seed ${index}.${ordinal} ${filler(
      repo * 7919777 + index * 7919 + ordinal,
      30,
    )}`;
    const line = user
      ? JSON.stringify({
          type: "user",
          message: { role: "user", content: text },
          timestamp,
          promptSource: "typed",
          uuid: `${session}-u${ordinal}`,
          parentUuid: ordinal === 0 ? null : `${session}-u${ordinal - 1}`,
          sessionId: session,
          cwd,
          version: "2.1.241",
          isSidechain: false,
          userType: "external",
          origin: { kind: "human" },
          entrypoint: "cli",
        })
      : JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text }] },
          timestamp,
          uuid: `${session}-u${ordinal}`,
          sessionId: session,
          isSidechain: false,
        });
    rows.push(line);
    size += line.length + 1;
    ordinal += 1;
  }
  return `${rows.join("\n")}\n`;
}

/** `claudeProjectDir`'s slug rule, duplicated here so the seeder needs no import. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

await mkdir(codexSessions, { recursive: true });
await mkdir(join(home, ".hermes"), { recursive: true });

const repos: string[] = [];
for (let repo = 0; repo < repoCount; repo += 1) {
  const cwd = repoPath(root, repo);
  repos.push(cwd);
  const project = join(claudeProjects, projectSlug(cwd));
  await mkdir(project, { recursive: true });
  for (let index = 0; index < CODEX_FILES; index += 1) {
    await writeFile(
      join(
        codexSessions,
        `rollout-2026-08-28T00-00-00-${codexSessionId(repo, index)}.jsonl`,
      ),
      codexLines(repo, index, cwd, CODEX_BYTES_PER_FILE),
    );
  }
  for (let index = 0; index < CLAUDE_FILES; index += 1) {
    await writeFile(
      join(project, `scale116-r${repo}-claude-${index}.jsonl`),
      claudeLines(repo, index, cwd, CLAUDE_BYTES_PER_FILE),
    );
  }
}

const perRepoBytes =
  CODEX_FILES * CODEX_BYTES_PER_FILE + CLAUDE_FILES * CLAUDE_BYTES_PER_FILE;
console.log(
  JSON.stringify({
    claudeProjects,
    codexSessions,
    // What a single watcher actually reads on cold start, which is the number
    // the 512 MiB ceiling sees. See the docblock.
    fleetVisibleBytes: perRepoBytes * repoCount,
    home,
    perRepoBytes,
    repoCount,
    repos,
  }),
);
