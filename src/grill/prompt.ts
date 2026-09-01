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
 * What it SAYS is the other half of the ticket. A grill session is owned by a
 * ticket, while §7.5 exempts its planning output from implementation-scope
 * enforcement. Registration, ticketing and lifecycle monitoring still apply.
 */
import type { GrillInvocation } from "./dispatch.ts";
import { GRILL_MODES } from "./skills.ts";

export interface GrillPromptInput {
  /** #97: the skill AND the form the session can actually reach it by. */
  invocation: GrillInvocation;
  /** SPEC §7.2's "X": what Johan wants to be grilled about. */
  topic: string;
  /** The ticket whose planning session is being opened. */
  ticket: string;
}

export function grillPrompt(input: GrillPromptInput): string {
  const { charter } = GRILL_MODES[input.invocation.mode];
  return [
    ...opening(input.invocation, charter),
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
    "Before planning, load the repository Wayfinder contract from",
    "docs/agents/WAYFINDER.md and follow it. When the decisions identify concrete",
    "work, file executable tickets rather than leaving implementation in prose;",
    "each ticket must carry verification commands fixed at creation time (R5; D4).",
    "",
    `Its owning ticket is #${input.ticket}. §7.5 exempts this session from`,
    "implementation-scope enforcement only; registration, ticketing and lifecycle",
    "monitoring still apply. Do not implement anything.",
    "Read the repo freely, write no code, and commit nothing.",
    "The output of this session is decisions: a spec, tickets, or a written answer.",
  ].join("\n");
}

/**
 * The one thing #97 changed, and the only place the form is spent (ticket #97).
 *
 * `skill`: byte-for-byte the sentence every grill has always opened with. The
 * three modes that were always model-invocable get an unchanged prompt, so the
 * §5 dispatch-hash match they already pass is not disturbed by this fix.
 *
 * `slash`: the id ALONE on the first line, because that is the only shape
 * `claude` expands. Everything after it becomes the command's arguments and
 * still reaches the model — measured on 2.1.247 against a
 * `disable-model-invocation: true` skill, both single-line and in this exact
 * multi-line shape (`docs/acceptance/grill-invocation-probe.txt`). The charter
 * moves down one line into "Use it to …" rather than being dropped: a slash
 * command carries the skill, not the reason for it.
 */
function opening(invocation: GrillInvocation, charter: string): string[] {
  if (invocation.form === "skill") {
    return [`Use the ${invocation.skill} skill and ${charter}.`];
  }
  return [`/${invocation.skill}`, "", `Use it to ${charter}.`];
}
