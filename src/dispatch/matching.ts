/**
 * Shared dumb-first dispatch matching (#132, #133).
 *
 * Matching is intentionally lexical and stable: dispatch must remain usable
 * without a metered brain, and equal candidates must sort by their path.
 * Retrieval returns source bytes; it never digests or paraphrases them.
 */
export function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export function overlap(query: Set<string>, candidate: string): number {
  let score = 0;
  for (const word of tokens(candidate)) if (query.has(word)) score += 1;
  return score;
}

export function ranked<T extends { searchable: string; path: string }>(
  query: string,
  values: T[],
): T[] {
  const words = tokens(query);
  return values
    .map((value) => ({ value, score: overlap(words, value.searchable) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.value.path.localeCompare(b.value.path))
    .map(({ value }) => value);
}
