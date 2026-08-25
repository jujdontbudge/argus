/**
 * The deterministic tier of the curator pass — no LLM, pure function.
 *
 * LIFTED near-verbatim (research #16 §8(ii)) from Hermes'
 * `apply_automatic_transitions` (`agent/curator.py:255-311`) plus
 * `latest_activity_at` (`tools/skill_usage.py:146-164`): the anchor is the
 * newest of use/view/patch falling back to `created_at`, ≥30 days idle is
 * `stale`, ≥90 days idle is archived, activity on a stale skill reactivates
 * it, `pinned` bypasses everything, and a skill seen for the FIRST time is
 * seeded and deferred a full cycle. That last rule is what makes the first
 * pass in a repo safe: nothing is archived until 90 days of *observed*
 * non-use, so an existing skills tree is never mass-pruned on day one.
 *
 * Archiving is a DECISION here, not an effect: the record is marked archived
 * only by `archiveSkill`, once the directory has actually moved. A crash
 * between the two leaves a live skill with a live record, which the next pass
 * simply decides again.
 */
import { latestActivityAt, emptyRecord, type UsageSidecar } from "./usage";

export interface TransitionThresholds {
  staleAfterDays: number;
  archiveAfterDays: number;
}

/** SPEC §5.1 / Hermes `hermes_cli/config.py:1852-1884`. */
export const DEFAULT_THRESHOLDS: TransitionThresholds = {
  staleAfterDays: 30,
  archiveAfterDays: 90,
};

export type TransitionKind =
  | "seeded"
  | "stale"
  | "reactivated"
  | "archive"
  | "pinned"
  | "unchanged";

export interface Transition {
  name: string;
  kind: TransitionKind;
  /** The timestamp the judgment was made against; null for a first sight. */
  anchor: string | null;
  /** Whole days between the anchor and now, for the report. */
  idleDays: number | null;
}

export interface TransitionResult {
  sidecar: UsageSidecar;
  transitions: Transition[];
  decisions: {
    /** Names the caller must archive; the move stamps the record. */
    archive: string[];
  };
}

export interface TransitionOptions extends TransitionThresholds {
  /** Epoch ms; injected so a pass is reproducible. */
  now: number;
}

const DAY_MS = 86_400_000;

/**
 * Judge every candidate against its usage record. `candidates` is what the
 * scan found on disk: a record without a candidate is carried untouched
 * (the skill was moved or hand-deleted — not the curator's business), and a
 * candidate without a record is seeded.
 */
export function applyAutomaticTransitions(
  sidecar: UsageSidecar,
  candidates: readonly string[],
  options: TransitionOptions,
): TransitionResult {
  const next: UsageSidecar = structuredClone(sidecar);
  const transitions: Transition[] = [];
  const archive: string[] = [];
  const nowIso = new Date(options.now).toISOString();
  const staleCutoff = options.now - options.staleAfterDays * DAY_MS;
  const archiveCutoff = options.now - options.archiveAfterDays * DAY_MS;

  for (const name of candidates) {
    const record = next[name];
    if (!record) {
      next[name] = emptyRecord(nowIso);
      transitions.push({ name, kind: "seeded", anchor: null, idleDays: null });
      continue;
    }
    if (record.pinned) {
      transitions.push({ name, kind: "pinned", anchor: null, idleDays: null });
      continue;
    }
    if (record.state === "archived") {
      transitions.push({ name, kind: "unchanged", anchor: null, idleDays: null });
      continue;
    }

    const anchor = latestActivityAt(record) ?? record.created_at;
    const anchorMs = Date.parse(anchor);
    const idleDays = Math.floor((options.now - anchorMs) / DAY_MS);

    if (anchorMs <= archiveCutoff) {
      archive.push(name);
      transitions.push({ name, kind: "archive", anchor, idleDays });
      continue;
    }
    if (anchorMs <= staleCutoff) {
      if (record.state === "active") {
        record.state = "stale";
        transitions.push({ name, kind: "stale", anchor, idleDays });
        continue;
      }
      transitions.push({ name, kind: "unchanged", anchor, idleDays });
      continue;
    }
    if (record.state === "stale") {
      record.state = "active";
      transitions.push({ name, kind: "reactivated", anchor, idleDays });
      continue;
    }
    transitions.push({ name, kind: "unchanged", anchor, idleDays });
  }

  return { sidecar: next, transitions, decisions: { archive } };
}
