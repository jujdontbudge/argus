import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  codexCandidateText,
  isCodexSubagentThread,
} from "../matching/candidates";
import type { SourceParser, TailEvent, TranscriptSource } from "./events";
import type { ReadResult } from "./line-reader";

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
    const absolute = resolve(path);
    let existing = absolute;
    while (true) {
      try {
        const canonicalParent = realpathSync.native(existing);
        return resolve(canonicalParent, relative(existing, absolute));
      } catch {
        const parent = dirname(existing);
        if (parent === existing) return absolute;
        existing = parent;
      }
    }
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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

function environmentCwd(text: string): string | undefined {
  if (!text.includes("<environment_context>")) return undefined;
  const match = /<cwd>([\s\S]*?)<\/cwd>/.exec(text);
  return match?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

class CodexParser implements SourceParser {
  private cwd: string | undefined;
  private gitBranch: string | undefined;
  private gitRepository: string | undefined;
  private isSubagent = false;
  private parentSessionId: string | undefined;
  private repo: string | undefined;
  private sessionId: string | undefined;
  private sessionTs: string | undefined;
  private version: string | undefined;

  constructor(private readonly file: string) {}

  private metaEvent(ts: string | undefined): TailEvent {
    return {
      type: "session-meta",
      sessionId: this.sessionId!,
      agent: "codex",
      ...(this.cwd !== undefined && { cwd: this.cwd }),
      ...(this.repo !== undefined && { repo: this.repo }),
      ...(this.parentSessionId !== undefined && {
        parentSessionId: this.parentSessionId,
      }),
      ...(this.gitBranch !== undefined && { gitBranch: this.gitBranch }),
      ...(this.version !== undefined && { version: this.version }),
      ...(ts !== undefined && { ts }),
      file: this.file,
    };
  }

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

    // Before 0.32 the first line was a flat metadata object and response
    // items were bare (not RolloutLine envelopes).
    if (record.type === undefined && !this.sessionId) {
      const id = str(record.id);
      if (!id) return [];
      this.sessionId = id;
      this.sessionTs = ts;
      const git = asRecord(record.git);
      this.gitBranch = git ? str(git.branch) : undefined;
      this.gitRepository = git ? str(git.repository_url) : undefined;
      return [];
    }

    if (record.type === "session_meta") {
      const payload = asRecord(record.payload);
      const id = payload ? str(payload.id) : undefined;
      if (!payload || !id || this.sessionId) return [];
      this.sessionId = id;
      this.sessionTs = ts;
      const rawCwd = str(payload.cwd);
      this.cwd = rawCwd ? canonicalPath(rawCwd) : undefined;
      const git = asRecord(payload.git);
      this.gitBranch = git ? str(git.branch) : undefined;
      this.gitRepository = git ? str(git.repository_url) : undefined;
      this.repo = this.resolveRepository();
      this.version = str(payload.cli_version);
      this.isSubagent = isCodexSubagentThread(payload.source);
      this.parentSessionId =
        str(payload.parent_thread_id) ?? str(payload.forked_from_id);
      return [this.metaEvent(ts)];
    }

    if (record.type === "turn_context" && this.sessionId) {
      const payload = asRecord(record.payload);
      const rawCwd = payload ? str(payload.cwd) : undefined;
      if (!rawCwd) return [];
      const cwd = canonicalPath(rawCwd);
      if (cwd === this.cwd) return [];
      this.cwd = cwd;
      this.repo = this.resolveRepository();
      return [this.metaEvent(ts)];
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
          candidate: !this.isSubagent && codexCandidateText(record) !== null,
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


    if (record.type === "message" && this.sessionId) {
      const role = record.role;
      if (role !== "user" && role !== "assistant") return [];
      const text = messageText(record, role);
      if (text === undefined) return [];
      const events: TailEvent[] = [];
      if (!this.cwd && role === "user") {
        const rawCwd = environmentCwd(text);
        if (rawCwd) {
          this.cwd = canonicalPath(rawCwd);
          this.repo = this.resolveRepository();
          events.push(this.metaEvent(this.sessionTs));
        }
      }
      events.push({
        type: "message",
        sessionId: this.sessionId,
        role,
        text,
        ts: ts ?? this.sessionTs ?? "",
        candidate:
          role === "user" &&
          codexCandidateText({ type: "response_item", payload: record }) !== null,
        file: this.file,
      });
      return events;
    }
    return [];
  }

  private resolveRepository(): string | undefined {
    if (!this.cwd) return undefined;
    if (pathExists(this.cwd)) return repositoryFor(this.cwd);
    if (!this.gitRepository) return undefined;
    return isAbsolute(this.gitRepository)
      ? canonicalPath(this.gitRepository)
      : this.gitRepository;
  }
}

function logicalRolloutName(file: string): string {
  return basename(file).replace(/\.zst$/, "");
}

class CodexLineReader {
  private readonly identities = new Map<
    string,
    { device: number; inode: number; path: string }
  >();

  async read(file: string, originalOffset: number): Promise<ReadResult> {
    let stat;
    let stored: Buffer;
    try {
      stat = statSync(file);
      stored = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { lines: [], offset: originalOffset, truncated: false };
      }
      throw error;
    }
    const content = file.endsWith(".jsonl.zst")
      ? Buffer.from(await Bun.zstdDecompress(stored))
      : stored;
    const key = logicalRolloutName(file);
    const previous = this.identities.get(key);
    const replacedAtSamePath =
      previous !== undefined &&
      previous.path === file &&
      (previous.device !== stat.dev || previous.inode !== stat.ino);
    let offset = originalOffset;
    const truncated = replacedAtSamePath || content.length < offset;
    if (truncated) offset = 0;
    this.identities.set(key, {
      device: stat.dev,
      inode: stat.ino,
      path: file,
    });

    if (content.length <= offset) return { lines: [], offset, truncated };
    const unread = content.subarray(offset);
    const lastNewline = unread.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], offset, truncated };
    return {
      lines: unread.toString("utf8", 0, lastNewline + 1).split("\n").slice(0, -1),
      offset: offset + lastNewline + 1,
      truncated,
    };
  }
}

async function rolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

export function createCodexSource(options: CodexSourceOptions): TranscriptSource {
  const sessions = join(options.codexHome, "sessions");
  const archived = join(options.codexHome, "archived_sessions");
  const reader = new CodexLineReader();
  return {
    id: "codex",
    watchPaths: () => [sessions, archived],
    listFiles: async () => {
      const files = [
        ...(await rolloutFiles(sessions)),
        ...(await rolloutFiles(archived)),
      ];
      const logical = new Map<string, string>();
      for (const file of files) {
        const key = logicalRolloutName(file);
        const previous = logical.get(key);
        if (!previous || (previous.endsWith(".zst") && !file.endsWith(".zst"))) {
          logical.set(key, file);
        }
      }
      return [...logical.values()].sort();
    },
    fileKey: logicalRolloutName,
    readNewLines: (file, offset) => reader.read(file, offset),
    createParser: (file) => new CodexParser(file.replace(/\.zst$/, "")),
  };
}
