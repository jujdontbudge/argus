/**
 * Dispatch-time project memory retrieval (#132).
 *
 * MEMORY.md is an index of fact files. Matching is bounded, deterministic,
 * and verbatim: a fact's index identity and complete file bytes travel to the
 * worker, or the fact is not selected. Missing/empty memory has no output so
 * existing dispatch prompts remain byte-identical.
 */
import { join } from "node:path";
import { ranked } from "./matching.ts";

export interface MemoryCaps { maxFacts: number; maxChars: number }
export const DEFAULT_MEMORY_CAPS: MemoryCaps = { maxFacts: 5, maxChars: 12_000 };

interface Fact { path: string; identity: string; searchable: string }

export async function dispatchMemoryPreamble(
  repo: string, query: string, caps: MemoryCaps = DEFAULT_MEMORY_CAPS,
): Promise<string> {
  const indexPath = join(repo, ".argus", "memory", "MEMORY.md");
  const index = Bun.file(indexPath);
  if (!(await index.exists())) return "";
  const text = await index.text();
  const facts: Fact[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:—|-)\s*(.*)$/);
    if (match) facts.push({ identity: line.trim(), path: match[2]!, searchable: `${match[1]} ${match[3]}` });
  }
  const selected: string[] = [];
  let size = 0;
  for (const fact of ranked(query, facts).slice(0, caps.maxFacts)) {
    const body = Bun.file(join(repo, ".argus", "memory", fact.path));
    if (!(await body.exists())) continue;
    const block = `### ${fact.identity}\n${await body.text()}`;
    if (size + block.length > caps.maxChars) continue;
    selected.push(block); size += block.length;
  }
  return selected.length === 0 ? "" : ["\n\nRECORDED PROJECT FACTS (verbatim from MEMORY.md):", ...selected].join("\n\n");
}
