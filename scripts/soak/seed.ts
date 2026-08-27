/**
 * Build the scratch world a soak runs against (#105).
 *
 * Everything lives under one scratch root: a scratch HOME (so CODEX_HOME,
 * CLAUDE_CONFIG_DIR and HERMES_HOME are all scratch), a scratch git repo, and
 * a seeded transcript history big enough that the #86 regression would be
 * unmistakable. #86 re-read every uncompressed rollout IN FULL on every poll;
 * with ~20 MiB of seeded history and a 250 ms poll, that bug re-allocates
 * ~80 MiB/s per eye. The fix reads zero bytes once the cursor is at EOF, so
 * the two states are separated by three orders of magnitude, not by statistics.
 *
 * Per-file size is deliberately ~1 MiB rather than one huge rollout: the very
 * first catchUp reads a whole file into one buffer, and a 20 MiB single file
 * would spike an eye toward the 512 MiB ceiling during WARM-UP — a restart
 * that would look like a ceiling failure but would really be an artefact of
 * the seed. Twenty small files exercise the same "scan every rollout" path.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: seed.ts <scratch-root>");

const home = join(root, "home");
const repo = join(root, "repo");
const codexSessions = join(home, ".codex", "sessions", "2026", "08", "26");
const claudeProjects = join(home, ".claude", "projects", "-scratch-soak-repo");

const CODEX_FILES = 20;
const CODEX_BYTES_PER_FILE = 1024 * 1024;
const CLAUDE_FILES = 4;
const CLAUDE_BYTES_PER_FILE = 512 * 1024;

/** Deterministic filler: no Math.random, so a reseed reproduces byte-for-byte. */
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

function codexSessionId(index: number): string {
  return `00000000-0000-0000-0000-${String(105000 + index).padStart(12, "0")}`;
}

function codexLines(index: number, cwd: string, bytes: number): string {
  const id = codexSessionId(index);
  const rows: string[] = [
    JSON.stringify({
      timestamp: "2026-08-26T00:00:00.000Z",
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
      timestamp: new Date(Date.UTC(2026, 7, 26, 0, 0, 0) + ordinal * 1000).toISOString(),
      ordinal,
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text: `seed ${index}.${ordinal} ${filler(index * 100003 + ordinal, 40)}`,
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

function claudeLines(index: number, cwd: string, bytes: number): string {
  const session = `soak-claude-${index}`;
  const rows: string[] = [];
  let size = 0;
  let ordinal = 0;
  while (size < bytes) {
    const user = ordinal % 2 === 0;
    const timestamp = new Date(
      Date.UTC(2026, 7, 26, 0, 0, 0) + ordinal * 1000,
    ).toISOString();
    const line = user
      ? JSON.stringify({
          type: "user",
          message: { role: "user", content: `seed ${index}.${ordinal} ${filler(index * 7919 + ordinal, 30)}` },
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
          message: {
            role: "assistant",
            content: [{ type: "text", text: `seed ${index}.${ordinal} ${filler(index * 7919 + ordinal, 30)}` }],
          },
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

await mkdir(codexSessions, { recursive: true });
await mkdir(claudeProjects, { recursive: true });
await mkdir(join(home, ".hermes"), { recursive: true });

for (let index = 0; index < CODEX_FILES; index += 1) {
  const file = join(
    codexSessions,
    `rollout-2026-08-26T00-00-00-${codexSessionId(index)}.jsonl`,
  );
  await writeFile(file, codexLines(index, repo, CODEX_BYTES_PER_FILE));
}

for (let index = 0; index < CLAUDE_FILES; index += 1) {
  await writeFile(
    join(claudeProjects, `soak-claude-${index}.jsonl`),
    claudeLines(index, repo, CLAUDE_BYTES_PER_FILE),
  );
}

console.log(
  JSON.stringify({
    claudeFiles: CLAUDE_FILES,
    claudeProjects,
    codexFiles: CODEX_FILES,
    codexSessions,
    seededBytes: CODEX_FILES * CODEX_BYTES_PER_FILE + CLAUDE_FILES * CLAUDE_BYTES_PER_FILE,
  }),
);
