/**
 * Content normalization for send↔transcript matching.
 *
 * Pipeline per research/send-transcript-matching.md §7, applied to both the
 * registry send text and every candidate transcript message. Each step is
 * load-bearing (evidence: NFC — probe E3c; LF — per-agent newline encodings;
 * per-line rstrip — probe E2a; outer strip — probe E4 on both agents).
 */
export function normalize(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
}
