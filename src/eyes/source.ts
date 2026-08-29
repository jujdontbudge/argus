import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  loadRegistry,
  ProvenanceClassifier,
  registryPaths,
  type ProvenanceAudit,
  type ProvenanceRecord,
  type SendRecord,
  type SessionRecord,
} from "../provenance/index.ts";
import {
  createClaudeCodeProjectsSource,
  createCodexSource,
  createHermesSource,
  readNewLines,
  type SourceParser,
  type TailEvent,
  type TranscriptSource,
  type CursorMap,
  Tailer,
} from "../tailing/index.ts";
import { canonicalPath, repositoryFor } from "../tailing/codex.ts";
import { loadHonchoBinding } from "./honcho/honcho.ts";

const SESSION_METADATA_LIMIT = 1024 * 1024;

type FileOwnership = "accepted" | "foreign" | "unknown";

interface RepoFilterBootstrap {
  cutoffMs: number;
  cursors: CursorMap;
}

function sourceCursorKey(source: TranscriptSource, file: string): string {
  return `${source.id}:${source.fileKey?.(file) ?? file}`;
}

async function bootstrapOwnership(
  source: TranscriptSource,
  file: string,
  bootstrap: RepoFilterBootstrap | undefined,
): Promise<Exclude<FileOwnership, "unknown"> | undefined> {
  if (!bootstrap) return undefined;
  if (sourceCursorKey(source, file) in bootstrap.cursors) return "accepted";
  const modifiedAt = await stat(file).then(({ mtimeMs }) => mtimeMs).catch(() => Infinity);
  return modifiedAt <= bootstrap.cutoffMs ? "foreign" : undefined;
}

async function readPrefixLines(file: string, upTo: number): Promise<string[]> {
  const transcript = Bun.file(file);
  const bytes = Math.min(transcript.size, upTo, SESSION_METADATA_LIMIT);
  const prefix = await transcript.slice(0, bytes).text();
  const lines = prefix.split("\n");
  if (!prefix.endsWith("\n")) lines.pop();
  return lines;
}

function eventBelongsToRepo(event: TailEvent, resolvedRepo: string): boolean {
  if (event.type !== "session-meta") return false;
  const eventRepo = [event.repo, event.cwd]
    .filter((path): path is string => path !== undefined)
    .map((path) => repositoryFor(path) ?? canonicalPath(path))
    .find((path) => path !== undefined);
  return eventRepo === resolvedRepo;
}

async function classifyFile(
  source: TranscriptSource,
  file: string,
  resolvedRepo: string,
): Promise<FileOwnership> {
  const parser = source.createParser(file);
  let sawMetadata = false;
  const inspect = (lines: readonly string[]): FileOwnership => {
    for (const line of lines) {
      for (const event of parser.parseLine(line)) {
        if (event.type !== "session-meta") continue;
        sawMetadata = true;
        if (eventBelongsToRepo(event, resolvedRepo)) return "accepted";
      }
    }
    return "unknown";
  };

  if (file.endsWith(".zst") && source.readNewLines) {
    const result = await source.readNewLines(file, 0);
    const classification = inspect(result.lines);
    if (classification === "accepted") return classification;
    return sawMetadata ? "foreign" : "unknown";
  }

  const classification = inspect(await readPrefixLines(file, SESSION_METADATA_LIMIT));
  if (classification === "accepted") return classification;
  return sawMetadata ? "foreign" : "unknown";
}

function sessionsForRepo(
  source: TranscriptSource,
  repo: string,
  bootstrap?: RepoFilterBootstrap,
): TranscriptSource {
  const resolvedRepo = repositoryFor(repo) ?? canonicalPath(repo);
  const ownership = new Map<string, Exclude<FileOwnership, "unknown">>();
  return {
    ...source,
    async listFiles(): Promise<string[]> {
      const accepted: string[] = [];
      for (const file of await source.listFiles()) {
        let classification = ownership.get(file);
        if (!classification) {
          classification = await bootstrapOwnership(source, file, bootstrap);
          if (classification) ownership.set(file, classification);
        }
        if (!classification) {
          const discovered = await classifyFile(source, file, resolvedRepo);
          if (discovered !== "unknown") {
            classification = discovered;
            ownership.set(file, discovered);
          }
        }
        if (classification === "accepted") accepted.push(file);
      }
      return accepted;
    },
    async primeParser(
      parser: SourceParser,
      file: string,
      upTo: number,
    ): Promise<void> {
      if (file.endsWith(".zst") && source.primeParser) {
        await source.primeParser(parser, file, upTo);
        return;
      }
      for (const line of await readPrefixLines(file, upTo)) {
        parser.parseLine(line);
      }
    },
    createParser(file: string): SourceParser {
      const parser = source.createParser(file);
      const accepted = new Set<string>();
      return {
        parseLine(line: string): TailEvent[] {
          const events = parser.parseLine(line);
          for (const event of events) {
            if (eventBelongsToRepo(event, resolvedRepo) && event.sessionId) {
              accepted.add(event.sessionId);
            }
          }
          return events.filter(
            (event) =>
              event.sessionId === undefined || accepted.has(event.sessionId),
          );
        },
      };
    },
  };
}

function combine(sources: readonly TranscriptSource[]): TranscriptSource {
  const owner = new Map<string, TranscriptSource>();
  return {
    id: "argus-repo",
    watchPaths: () => [...new Set(sources.flatMap((source) => source.watchPaths()))],
    async listFiles() {
      const groups = await Promise.all(
        sources.map(async (source) => ({ source, files: await source.listFiles() })),
      );
      const files: string[] = [];
      for (const group of groups) {
        for (const file of group.files) {
          owner.set(file, group.source);
          files.push(file);
        }
      }
      return files.sort();
    },
    fileKey(file) {
      const source = owner.get(file);
      return `${source?.id ?? "unknown"}:${source?.fileKey?.(file) ?? file}`;
    },
    readNewLines(file, offset) {
      const source = owner.get(file);
      if (source === undefined) {
        return Promise.resolve({ lines: [], offset, truncated: false });
      }
      return source.readNewLines
        ? source.readNewLines(file, offset)
        : readNewLines(file, offset);
    },
    async primeParser(parser, file, upTo) {
      const source = owner.get(file);
      if (source === undefined) throw new Error(`no transcript source owns ${file}`);
      if (source.primeParser) {
        await source.primeParser(parser, file, upTo);
        return;
      }
      const prior = source.readNewLines
        ? await source.readNewLines(file, 0)
        : await readNewLines(file, 0);
      let consumed = 0;
      for (const line of prior.lines) {
        if (consumed >= upTo) break;
        consumed += Buffer.byteLength(line, "utf8") + 1;
        parser.parseLine(line);
      }
    },
    createParser(file) {
      const source = owner.get(file);
      if (source === undefined) throw new Error(`no transcript source owns ${file}`);
      return source.createParser(file);
    },
  };
}

async function loadRepoFilterBootstrap(
  repo: string,
): Promise<RepoFilterBootstrap | undefined> {
  try {
    const marker = (await Bun.file(
      join(repo, ".argus", "start-from-now.json"),
    ).json()) as { cutoff?: unknown };
    if (typeof marker.cutoff !== "string") return undefined;
    const cutoffMs = Date.parse(marker.cutoff);
    if (!Number.isFinite(cutoffMs)) return undefined;
    const raw = (await Bun.file(
      join(repo, ".argus", "eyes", "reviewer", "cursors.json"),
    ).json()) as Record<string, unknown>;
    const cursors = Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && entry[1] >= 0,
      ),
    );
    return { cutoffMs, cursors };
  } catch {
    return undefined;
  }
}

export async function createRepoTranscriptSource(
  repo: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TranscriptSource> {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set");
  const claudeRoot = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  const hermesRoot = env.HERMES_HOME ?? join(home, ".hermes");
  const { workspace } = await loadHonchoBinding(repo);
  const bootstrap = await loadRepoFilterBootstrap(repo);
  return combine([
    sessionsForRepo(
      createClaudeCodeProjectsSource({
        projectsRoot: join(claudeRoot, "projects"),
      }),
      repo,
      bootstrap,
    ),
    sessionsForRepo(createCodexSource({ codexHome }), repo, bootstrap),
    createHermesSource({ hermesRoot, profiles: [workspace] }),
  ]);
}

export interface ProvenanceBatch {
  audits: ProvenanceAudit[];
  records: ProvenanceRecord[];
  sessions: Array<{ cwd: string; sessionId: string }>;
}

function rowKey(row: SessionRecord | SendRecord): string {
  return JSON.stringify(row);
}

/** One watcher's stateful registry classifier over its repo-scoped source. */
export class ProvenanceFeed {
  readonly #classifier = new ProvenanceClassifier();
  readonly #repo: string;
  readonly #seenSends = new Set<string>();
  readonly #seenSessions = new Set<string>();
  readonly #tailer: Tailer;

  constructor(
    source: TranscriptSource,
    repo: string,
    cursors: CursorMap = {},
  ) {
    this.#repo = repo;
    this.#tailer = new Tailer(source, { cursors });
  }

  cursors(): CursorMap {
    return this.#tailer.cursors();
  }

  async #syncRegistry(): Promise<ProvenanceAudit[]> {
    const registry = await loadRegistry(registryPaths(this.#repo));
    const audits: ProvenanceAudit[] = [...registry.audits];
    for (const session of registry.sessions) {
      const key = rowKey(session);
      if (this.#seenSessions.has(key)) continue;
      this.#seenSessions.add(key);
      audits.push(...this.#classifier.registerSession(session));
    }
    for (const send of registry.sends) {
      const key = rowKey(send);
      if (this.#seenSends.has(key)) continue;
      this.#seenSends.add(key);
      audits.push(...this.#classifier.recordSend(send));
    }
    return audits;
  }

  async catchUp(): Promise<ProvenanceBatch> {
    const audits = await this.#syncRegistry();
    const records: ProvenanceRecord[] = [];
    const sessions: Array<{ cwd: string; sessionId: string }> = [];
    for (const event of await this.#tailer.catchUp()) {
      if (event.type === "session-meta" && event.cwd !== undefined) {
        sessions.push({ cwd: event.cwd, sessionId: event.sessionId });
      }
      const output = this.#classifier.handle(event);
      audits.push(...output.audits);
      if (output.record !== null) records.push(output.record);
    }
    audits.push(...this.#classifier.sweep(Date.now()));
    return { audits, records, sessions };
  }
}
