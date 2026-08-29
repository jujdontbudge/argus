import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openArchiver } from "../eyes/archiver/archiver.ts";
import { createRepoTranscriptSource } from "../eyes/source.ts";
import { EYE_NAMES } from "../supervisor/runtime.ts";
import { readEnabledRepos } from "../supervisor/registry.ts";
import type { CursorMap, TranscriptSource } from "../tailing/index.ts";

const TAIL_SCAN_BYTES = 64 * 1024;

async function completeLineOffset(file: string): Promise<number> {
  const transcript = Bun.file(file);
  let end = transcript.size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_SCAN_BYTES);
    const bytes = Buffer.from(await transcript.slice(start, end).arrayBuffer());
    const newline = bytes.lastIndexOf(0x0a);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function persistJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function snapshotCursors(source: TranscriptSource): Promise<CursorMap> {
  const cursors: CursorMap = {};
  for (const file of await source.listFiles()) {
    if (file.endsWith(".zst")) {
      throw new Error(
        `argus up --from-now: cannot safely snapshot compressed transcript ${file}`,
      );
    }
    const key = source.fileKey?.(file) ?? file;
    cursors[key] = await completeLineOffset(file);
  }
  return cursors;
}

export interface StartFromNowReport {
  files: number;
  bytes: number;
  cutoff: string;
}

/**
 * Move every eye's durable frontier to the last complete line currently on disk.
 * Existing transcript bytes remain untouched and can be imported separately.
 */
export async function startFromNow(
  repo: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StartFromNowReport> {
  const home = env.HOME;
  if (!home) throw new Error("argus up --from-now: HOME is not set");
  const registry = env.ARGUS_REPOS_FILE ?? join(home, ".argus-repos");
  if ((await readEnabledRepos(registry)).includes(repo)) {
    throw new Error(
      `argus up --from-now: ${repo} is already running; run argus down first`,
    );
  }

  const source = await createRepoTranscriptSource(repo, env);
  const cursors = await snapshotCursors(source);
  const cutoff = new Date().toISOString();

  for (const eye of EYE_NAMES) {
    if (eye === "archiver") continue;
    await persistJson(
      join(repo, ".argus", "eyes", eye, "cursors.json"),
      cursors,
    );
  }

  const archiver = await openArchiver(repo);
  try {
    archiver.replaceCursors(cursors);
  } finally {
    archiver.close();
  }

  await persistJson(join(repo, ".argus", "start-from-now.json"), {
    cutoff,
    files: Object.keys(cursors).length,
  });
  return {
    bytes: Object.values(cursors).reduce((sum, offset) => sum + offset, 0),
    cutoff,
    files: Object.keys(cursors).length,
  };
}
