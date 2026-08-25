import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { codexCandidateText } from "../matching/candidates";
import type { SourceParser, TailEvent, TranscriptSource } from "./events";

export interface CodexSourceOptions {
  /** Isolated Codex state root. Production passes `~/.codex`. */
  codexHome: string;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function repositoryFor(cwd: string): string | undefined {
  let directory = canonicalPath(cwd);
  try {
    if (!lstatSync(directory).isDirectory()) directory = dirname(directory);
  } catch {
    return undefined;
  }

  while (true) {
    const dotGit = join(directory, ".git");
    try {
      const stat = lstatSync(dotGit);
      if (stat.isDirectory()) return canonicalPath(directory);
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
        if (!match?.[1]) return canonicalPath(directory);
        const gitdir = resolve(directory, match[1]);
        const common = gitdir.replace(/[/\\]worktrees[/\\][^/\\]+[/\\]?$/, "");
        return canonicalPath(common.endsWith("/.git") ? dirname(common) : common);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function messageText(item: Rec, role: "user" | "assistant"): string | undefined {
  if (item.type !== "message" || item.role !== role || !Array.isArray(item.content)) {
    return undefined;
  }
  const expected = role === "user" ? "input_text" : "output_text";
  const parts = item.content.flatMap((value) => {
    const part = asRecord(value);
    return part?.type === expected && typeof part.text === "string" ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

class CodexParser implements SourceParser {
  private sessionId: string | undefined;

  constructor(private readonly file: string) {}

  parseLine(line: string): TailEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [{ type: "lifecycle", kind: "parse-error", content: line, file: this.file }];
    }
    const record = asRecord(parsed);
    if (!record) return [];
    const ts = str(record.timestamp);

    if (record.type === "session_meta") {
      const payload = asRecord(record.payload);
      const id = payload ? str(payload.id) : undefined;
      if (!payload || !id || this.sessionId) return [];
      this.sessionId = id;
      const rawCwd = str(payload.cwd);
      const cwd = rawCwd ? canonicalPath(rawCwd) : undefined;
      const version = str(payload.cli_version);
      return [{
        type: "session-meta",
        sessionId: id,
        agent: "codex",
        ...(cwd !== undefined && { cwd }),
        ...(cwd !== undefined && repositoryFor(cwd) !== undefined && { repo: repositoryFor(cwd) }),
        ...(version !== undefined && { version }),
        ...(ts !== undefined && { ts }),
        file: this.file,
      }];
    }

    if (record.type === "response_item" && this.sessionId && ts) {
      const payload = asRecord(record.payload);
      if (!payload) return [];
      const userText = messageText(payload, "user");
      if (userText !== undefined) {
        return [{
          type: "message",
          sessionId: this.sessionId,
          role: "user",
          text: userText,
          ts,
          candidate: codexCandidateText(record) !== null,
          file: this.file,
        }];
      }
      const assistantText = messageText(payload, "assistant");
      if (assistantText !== undefined) {
        return [{
          type: "message",
          sessionId: this.sessionId,
          role: "assistant",
          text: assistantText,
          ts,
          candidate: false,
          file: this.file,
        }];
      }
    }
    return [];
  }
}

async function rolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

export function createCodexSource(options: CodexSourceOptions): TranscriptSource {
  const sessions = join(options.codexHome, "sessions");
  const archived = join(options.codexHome, "archived_sessions");
  return {
    id: "codex",
    watchPaths: () => [sessions, archived],
    listFiles: async () => [
      ...(await rolloutFiles(sessions)),
      ...(await rolloutFiles(archived)),
    ].sort(),
    createParser: (file) => new CodexParser(file),
  };
}
