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
  claudeProjectDir,
  createClaudeCodeSource,
  createCodexSource,
  createHermesSource,
  readNewLines,
  type SourceParser,
  type TailEvent,
  type TranscriptSource,
  type CursorMap,
  Tailer,
} from "../tailing/index.ts";
import { loadHonchoBinding } from "./honcho/honcho.ts";

function codexForRepo(source: TranscriptSource, repo: string): TranscriptSource {
  return {
    ...source,
    createParser(file: string): SourceParser {
      const parser = source.createParser(file);
      const accepted = new Set<string>();
      return {
        parseLine(line: string): TailEvent[] {
          const events = parser.parseLine(line);
          for (const event of events) {
            if (
              event.type === "session-meta" &&
              (event.repo === repo || event.cwd === repo)
            ) {
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
    createParser(file) {
      const source = owner.get(file);
      if (source === undefined) throw new Error(`no transcript source owns ${file}`);
      return source.createParser(file);
    },
  };
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
  return combine([
    createClaudeCodeSource({
      dir: claudeProjectDir(repo, join(claudeRoot, "projects")),
    }),
    codexForRepo(createCodexSource({ codexHome }), repo),
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
