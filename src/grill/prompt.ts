/**
 * The grill dispatch prompt (ticket #62).
 *
 * This is the text SPEC §5 rule 1 makes durable before the session starts, and
 * the text that has to classify `hermes`/`dispatch-prompt` when it lands. Two
 * consequences shape how it is built:
 *
 * 1. **It is built once and used twice** — recorded in `sessions.jsonl` and
 *    typed into the terminal — from the same string. A prompt assembled twice
 *    is a prompt that can differ by a byte, and a byte is enough to miss the
 *    dispatch hash and classify as Johan.
 * 2. **No trailing whitespace and no trailing newline.** The matcher
 *    normalises before hashing, so a difference here would not actually break
 *    the match; keeping it clean means the registry's copy and the terminal's
 *    copy are identical without relying on that.
 *
 * What it SAYS is the other half of the ticket. A grill session is the one
 * deployed session with no ticket (§7.5 exempts planning and grilling), which
 * means none of the ticket-shaped guardrails the dispatch prompt leans on
 * exist here: nothing bounds its scope, nothing owns its closure, and the
 * Retro eye will file a sub-issue against any implementation it does do
 * (§5.5 / §7.5 — a ticketless deployment that leaves commits is rogue by
 * construction). So the prompt says that outright rather than leaving the
 * session to discover it by being reported.
 */
import { GRILL_MODES, type ResolvedGrillSkill } from "./skills.ts";

export interface GrillPromptInput {
  resolved: ResolvedGrillSkill;
  /** SPEC §7.2's "X": what Johan wants to be grilled about. */
  topic: string;
}

export function grillPrompt(input: GrillPromptInput): string {
  const { charter } = GRILL_MODES[input.resolved.mode];
  return [
    `Use the ${input.resolved.skill} skill and ${charter}.`,
    "",
    "The topic:",
    "",
    input.topic.trim(),
    "",
    "This is an Argus planning session (SPEC §7.2). Johan is attaching to this",
    "terminal and will answer here directly, so ask him one question at a time and",
    "wait for his answer — do not answer on his behalf and do not summarise your way",
    "past a disagreement.",
    "",
    "It has no ticket, on purpose: §7.5 exempts planning and grilling. That also",
    "means nothing here bounds implementation scope, so do not implement anything.",
    "Read the repo freely, write no code, and commit nothing — a ticketless session",
    "that leaves commits behind is what the Retro watcher files a sub-issue about.",
    "The output of this session is decisions: a spec, tickets, or a written answer.",
  ].join("\n");
}
