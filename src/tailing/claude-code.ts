/**
 * Claude Code transcript source: `<dir>/*.jsonl` session files (research
 * §2.1/§2.3 shapes). The directory is configurable — production points at
 * `~/.claude/projects/<slug>`, tests at temp dirs.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeCandidateText } from "../matching/candidates";
import { repositoryFor } from "./codex";
import type { SourceParser, TailEvent, TranscriptSource } from "./events";

/**
 * Map a project cwd to its Claude Code transcript directory: the slug is the
 * cwd with every non-alphanumeric byte replaced by "-" (observed convention,
 * research appendix). `projectsRoot` is configurable; production passes
 * `~/.claude/projects`.
 */
export function claudeProjectDir(cwd: string, projectsRoot: string): string {
  return join(projectsRoot, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export interface ClaudeCodeSourceOptions {
  /** The slug directory holding this project's `*.jsonl` session files. */
  dir: string;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

class ClaudeCodeParser implements SourceParser {
  private metaSeen = new Set<string>();

  constructor(private readonly file: string) {}

  parseLine(line: string): TailEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [
        { type: "lifecycle", kind: "parse-error", content: line, file: this.file },
      ];
    }
    const rec = asRecord(parsed);
    if (!rec) return [];
    const events: TailEvent[] = [];
    const sessionId = str(rec.sessionId);
    const ts = str(rec.timestamp);

    // #49: emit session-meta from the first record that actually CARRIES the
    // session's identity, not merely the first one that names it. A real
    // Claude Code transcript opens with `queue-operation`, `atis-latch` and
    // `last-prompt` records that have a sessionId and no `cwd` at all.
    // Latching on those emitted a cwd-less meta and then suppressed the real
    // one forever, which is how §7.3/#22's worktree-to-parent-repo mapping
    // would have gone quietly missing on every live Claude session. `cwd` is
    // the whole payload of this event, so a meta without one is not worth
    // emitting either. Fixtures never showed it: fixtures start with `user`.
    const cwd = str(rec.cwd);
    if (sessionId && cwd !== undefined && !this.metaSeen.has(sessionId)) {
      this.metaSeen.add(sessionId);
      const repo = repositoryFor(cwd);
      const version = str(rec.version);
      events.push({
        type: "session-meta",
        sessionId,
        agent: "claude-code",
        cwd,
        ...(repo !== undefined && { repo }),
        ...(version !== undefined && { version }),
        ...(ts !== undefined && { ts }),
        file: this.file,
      });
    }

    if (rec.type === "user" && sessionId && ts) {
      const message = asRecord(rec.message);
      const content = message ? str(message.content) : undefined;
      if (content !== undefined) {
        const uuid = str(rec.uuid);
        const promptSource = str(rec.promptSource);
        events.push({
          type: "message",
          sessionId,
          role: "user",
          text: content,
          ts,
          ...(uuid !== undefined && { uuid }),
          ...(promptSource !== undefined && { promptSource }),
          candidate: claudeCandidateText(rec) !== null,
          file: this.file,
        });
      }
    }

    if (rec.type === "queue-operation") {
      const kind =
        rec.operation === "enqueue"
          ? ("queue-enqueue" as const)
          : rec.operation === "dequeue"
            ? ("queue-dequeue" as const)
            : null;
      if (kind) {
        const content = str(rec.content);
        events.push({
          type: "lifecycle",
          kind,
          ...(sessionId !== undefined && { sessionId }),
          ...(ts !== undefined && { ts }),
          ...(content !== undefined && { content }),
          file: this.file,
        });
      }
    }

    if (rec.type === "assistant" && sessionId && ts) {
      const message = asRecord(rec.message);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const parts: string[] = [];
      for (const block of blocks) {
        const b = asRecord(block);
        if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      if (parts.length > 0) {
        const uuid = str(rec.uuid);
        events.push({
          type: "message",
          sessionId,
          role: "assistant",
          text: parts.join("\n"),
          ts,
          ...(uuid !== undefined && { uuid }),
          candidate: false,
          file: this.file,
        });
      }
    }

    return events;
  }
}

export function createClaudeCodeSource(
  options: ClaudeCodeSourceOptions,
): TranscriptSource {
  const { dir } = options;
  return {
    id: "claude-code",
    watchPaths: () => [dir],
    listFiles: async () => {
      const names = await readdir(dir).catch(() => [] as string[]);
      return names
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(dir, name));
    },
    createParser: (file) => new ClaudeCodeParser(file),
  };
}
