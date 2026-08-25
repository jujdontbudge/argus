/**
 * Nearest-plausible-parent resolution (SPEC §5.5: "a sub-issue of the nearest
 * parent ticket where one exists").
 *
 * Deterministic evidence first, the brain only as a tiebreaker:
 *
 * 1. `session-ticket` — a registered ticket session was working in this
 *    checkout, so the work sits beside that ticket even though it is outside
 *    its scope. This is the §7.4/§14 case: Johan hijacks ticket #7's session
 *    and does something extra; the retro belongs under #7.
 * 2. `referenced-ticket` — the rogue commits (or Johan's prompts) name a
 *    ticket number themselves.
 * 3. `brain-choice` — the model's pick, VALIDATED against tickets that
 *    actually exist. A model may not invent an issue number.
 * 4. `root-level` — no plausible parent; a plain closed retro issue.
 *
 * Rules 1 and 2 are trusted without the candidate list because they come from
 * the registry and from committed text: a claimed ticket is often already
 * closed by the time its retro files, and a closed ticket is still the right
 * parent. Retro tickets themselves are never parents — retros do not nest.
 */
import type { TrackerIssue } from "./gh";

export type ParentRule =
  | "session-ticket"
  | "referenced-ticket"
  | "brain-choice"
  | "root-level";

export interface ParentInput {
  /** Tickets of registered sessions observed working in this checkout. */
  sessionTickets: readonly string[];
  /** Ticket numbers the rogue work names. */
  referencedTickets: readonly string[];
  /** The brain's choice, or null. */
  brainChoice: string | null;
  /** Open tracker issues — the only numbers the brain may choose from. */
  candidates: readonly TrackerIssue[];
}

export interface ParentResolution {
  parent: string | null;
  rule: ParentRule;
}

const RETRO_LABEL = "retro";

/**
 * The brain's pick as a bare ticket number, or null when it is not one.
 *
 * `parentTicket` is free-form model output: the run that returns `15` returns
 * `#15` on the next pass (#42, and the live-brain flake that cost three
 * tickets a re-run). The judgment is WHICH ticket; the punctuation is not part
 * of it, and an exact compare silently files at root level a retro whose
 * parent Argus actually has. Anything that is not a single number is still
 * unusable, so §5.5's "a model may not invent an issue number" is untouched.
 */
function pickedNumber(choice: string | null): string | null {
  if (choice === null) return null;
  const picked = /^#?\s*(\d+)$/.exec(choice.trim());
  return picked ? picked[1]! : null;
}

export function resolveParent(input: ParentInput): ParentResolution {
  const sessionTicket = input.sessionTickets.find((ticket) => /^\d+$/.test(ticket));
  if (sessionTicket !== undefined) {
    return { parent: sessionTicket, rule: "session-ticket" };
  }

  const referenced = input.referencedTickets.find((ticket) => /^\d+$/.test(ticket));
  if (referenced !== undefined) {
    return { parent: referenced, rule: "referenced-ticket" };
  }

  const brainChoice = pickedNumber(input.brainChoice);
  if (brainChoice !== null) {
    const chosen = input.candidates.find((issue) => issue.number === brainChoice);
    if (chosen !== undefined && !chosen.labels.includes(RETRO_LABEL)) {
      return { parent: chosen.number, rule: "brain-choice" };
    }
  }

  return { parent: null, rule: "root-level" };
}
