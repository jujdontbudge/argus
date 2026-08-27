#!/usr/bin/env bun
/**
 * Capture the record-shape contract from the records the CLIs ACTUALLY write
 * (#100). Read-only, always: it opens transcripts and the Hermes database for
 * reading and writes exactly one file, `src/tailing/shape/baseline.json`.
 *
 * This script is why `baseline.json` is a snapshot rather than a constants
 * table. #89 resolves the ACTIVE plugin install instead of globbing a cache
 * and #97 reads a skill's invocation form off the SKILL.md the session will
 * load; the same idea one level down is that the shape of a codex rollout or
 * a claude transcript is knowable only from a codex rollout or a claude
 * transcript. Nobody publishes a schema for either. So the contract is
 * captured, stamped with the CLI versions that wrote the corpus, and
 * committed — and re-captured by re-running this, never hand-edited.
 *
 * Committing the snapshot (rather than learning it at run time) is the whole
 * point: a baseline that keeps learning absorbs the drift it exists to report.
 *
 *   bun scripts/shape/capture-baseline.ts [--out <file>]
 *
 * It never opens `~/.claude/.credentials.json`, `~/.hermes/.env` or
 * `~/.hermes/auth.json`, and never writes under any real agent home.
 */
import { Database, constants } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  factKey,
  hermesSchemaFacts,
  observeClaudeRecord,
  observeCodexRecord,
  type ShapeBaseline,
  type ShapeFact,
} from "../../src/tailing/shape/contract.ts";

// Default to the WHOLE corpus. A thin baseline is not a safer baseline — it
// is a noisier one, because every shape it failed to sample becomes a false
// alarm on the day it is next written. Capping is for the drift probe only.
const MAX_FILES = Number(process.env.ARGUS_SHAPE_MAX_FILES ?? 100_000);
/**
 * Newest-first by default. `ARGUS_SHAPE_ORDER=oldest` is what makes the drift
 * probe possible: capture from the oldest corpus, then run the canary over the
 * newest, and every fact it reports is real drift that really happened.
 */
const OLDEST_FIRST = process.env.ARGUS_SHAPE_ORDER === "oldest";
const MAX_BYTES_PER_FILE = 96 * 1024 * 1024;

interface Collected {
  facts: Set<string>;
  files: number;
  records: number;
  versions: Set<string>;
}

function collector(): Collected {
  return { facts: new Set(), files: 0, records: 0, versions: new Set() };
}

function absorb(into: Collected, observed: readonly ShapeFact[]): void {
  for (const fact of observed) {
    into.facts.add(factKey(fact));
    if (fact.dimension === "cli-version") into.versions.add(fact.token);
  }
}

async function* jsonlUnder(root: string, depth = 4): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const ordered = entries.sort((a, b) =>
    OLDEST_FIRST ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name),
  );
  for (const entry of ordered) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth > 0) yield* jsonlUnder(path, depth - 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function sweep(
  root: string,
  observe: (record: unknown) => ShapeFact[],
): Promise<Collected> {
  const into = collector();
  for await (const file of jsonlUnder(root)) {
    if (into.files >= MAX_FILES) break;
    const handle = Bun.file(file);
    if (handle.size === 0 || handle.size > MAX_BYTES_PER_FILE) continue;
    let text: string;
    try {
      text = await handle.text();
    } catch {
      continue;
    }
    into.files += 1;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      into.records += 1;
      absorb(into, observe(parsed));
    }
  }
  return into;
}

/**
 * Hermes's contract is a schema, so it is read off the database with PRAGMA
 * rather than inferred from rows: the reader's own `SELECT` filters
 * `role IN ('user','assistant')`, so a third role could never appear in a row
 * this process sees.
 */
async function sweepHermes(stateDb: string): Promise<Collected> {
  const into = collector();
  if (!(await Bun.file(stateDb).exists())) return into;
  const db = new Database(
    `${pathToFileURL(stateDb).href}?mode=ro&immutable=0`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
  try {
    const columns: Record<string, string[]> = {};
    for (const table of ["sessions", "messages"]) {
      columns[table] = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
    }
    const roles = db
      .query<{ role: string | null }, []>("SELECT DISTINCT role FROM messages")
      .all()
      .flatMap((row) => (typeof row.role === "string" ? [row.role] : []));
    const rows = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM messages")
      .get();
    into.files = 1;
    into.records = rows?.count ?? 0;
    absorb(into, hermesSchemaFacts(columns, roles));
    // The row shape the reader hands the parser is fixed by its own SELECT
    // aliases, so it is pinned from the alias list rather than sampled — a
    // column WE stopped selecting is a change to this repo, not to Hermes.
    for (const field of [
      "id",
      "sessionId",
      "role",
      "content",
      "timestamp",
      "parentSessionId",
      "startedAt",
      "cwd",
      "model",
    ]) {
      into.facts.add(factKey({ dimension: "field", path: "", token: field }));
    }
  } finally {
    db.close();
  }
  return into;
}

async function cliVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([command, ...args], { stderr: "ignore", stdout: "pipe" });
    const text = (await new Response(proc.stdout).text()).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

const out =
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : join(import.meta.dir, "../../src/tailing/shape/baseline.json");

const home = homedir();
const [claude, codex, hermes, claudeCli, codexCli] = await Promise.all([
  sweep(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude/projects"), observeClaudeRecord),
  sweep(join(process.env.CODEX_HOME ?? join(home, ".codex"), "sessions"), observeCodexRecord),
  sweepHermes(join(process.env.HERMES_HOME ?? join(home, ".hermes"), "state.db")),
  cliVersion("claude", ["--version"]),
  cliVersion("codex", ["--version"]),
]);

// The versions the CORPUS carries are the contract's real stamp; the installed
// binary is recorded beside them because a corpus can lag an upgrade by days,
// and the gap between the two is itself worth seeing.
const baseline: ShapeBaseline = {
  capturedAt: new Date().toISOString(),
  corpus: {
    "claude-code": { files: claude.files, records: claude.records },
    codex: { files: codex.files, records: codex.records },
    hermes: { files: hermes.files, records: hermes.records },
  },
  facts: {
    "claude-code": [...claude.facts].sort(),
    codex: [...codex.facts].sort(),
    hermes: [...hermes.facts].sort(),
  },
  versions: {
    "claude-code": [...claude.versions].sort(),
    "claude-code-installed": claudeCli === null ? [] : [claudeCli],
    codex: [...codex.versions].sort(),
    "codex-installed": codexCli === null ? [] : [codexCli],
  },
};

await Bun.write(out, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(
  `captured ${claude.records} claude / ${codex.records} codex records, ` +
    `${hermes.records} hermes messages -> ${out}`,
);
