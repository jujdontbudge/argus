/**
 * Dispatch-time MEMORY.md snapshot (#134).
 *
 * The registry row is the provenance boundary for a deployment. This tiny
 * snapshot is deliberately append-only data: the entry ids and the exact
 * index hash describe what Argus knew before the worker started. Later memory
 * writes therefore cannot become a false known-pitfall repeat.
 */
import { hashText } from "../matching";

export interface MemorySnapshot {
  entries: string[];
  contentHash: string;
}

export async function snapshotMemory(memoryPath: string): Promise<MemorySnapshot> {
  const file = Bun.file(memoryPath);
  const text = (await file.exists()) ? await file.text() : "";
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.match(/\]\(([^)]+\.md)\)/)?.[1])
    .filter((entry): entry is string => entry !== undefined);
  return { entries, contentHash: hashText(text) };
}
