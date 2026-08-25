import { createHash } from "node:crypto";
import { normalize } from "./normalize";

/** SHA-256 hex digest of the UTF-8 bytes of `s`, unnormalized. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * The matching hash: sha256 over the UTF-8 bytes of normalize(s)
 * (research/send-transcript-matching.md §7).
 */
export function hashText(s: string): string {
  return sha256Hex(normalize(s));
}
