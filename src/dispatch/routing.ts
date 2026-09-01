/**
 * Label → agent routing (ticket #88), which is SPEC §2's table and nothing
 * else:
 *
 * > Routing is by ticket label. Hermes reads the label and picks the worker:
 * > `grilling`, `spec`, `tickets`, `review`, `diagnosis` → Claude Code; implementation
 * > tickets (default) → Codex; exceptions can be pinned per-ticket with an
 * > explicit `agent:claude-code` / `agent:codex` label.
 *
 * Until this module existed the labels were fetched (`./frontier.ts` asks
 * `gh` for `number,title,body,labels,assignees`) and then thrown away:
 * `dispatchFrontier` did `options.agent ?? "claude"`, so every implementation
 * ticket went to the planning agent and a pin was ignored in silence.
 *
 * THE PLANNING HALF OF THE TABLE IS NOT REWRITTEN HERE. `GRILL_MODES`
 * (`../grill/skills.ts`) already names an agent per planning label, and SPEC
 * §1's "one store, many readers" applies to a routing table as much as to a
 * skills store: a second copy of `spec → claude` is a second thing to keep
 * true. So the planning half is READ off `GRILL_MODES`, and the only rows
 * this file owns are the default and the pins.
 *
 * WHAT IT WILL NOT DO IS GUESS. A ticket carrying both pins, or a pin naming
 * an agent Argus cannot deploy, is REFUSED — not quietly resolved to a
 * default. A quiet default is exactly how the defect this module fixes
 * survived: the wrong agent runs, produces plausible work, and nothing
 * anywhere looks wrong. A refusal costs one deferred ticket and says so in
 * `DispatchReport.degraded` (ADR-0001), and the label is a one-word fix on
 * the tracker.
 */
import type { DeployAgent } from "../deploy";
import { GRILL_MODES, isGrillMode } from "../grill/skills.ts";

/** The `agent:` label prefix SPEC §2 names for per-ticket pins. */
const PIN_PREFIX = "agent:";

/**
 * The pins Argus honours.
 *
 * `agent:claude-code` is SPEC §2's literal spelling; `agent:claude` is the
 * name the rest of the tree uses for the same agent (`DeployAgent`,
 * `ROUTES`, the registry's `agent` column), and a human labelling a ticket
 * will reach for whichever they last read. Both mean Claude Code. Anything
 * else under the prefix is unknown, and unknown is a refusal.
 */
const PINS: Readonly<Record<string, DeployAgent>> = {
  "agent:claude": "claude",
  "agent:claude-code": "claude",
  "agent:codex": "codex",
  "agent:hermes": "hermes",
};

/**
 * SPEC §2: "implementation tickets (default) → Codex." The default is stated,
 * not chosen here.
 */
export const DEFAULT_AGENT: DeployAgent = "codex";

export type AgentRouting =
  | { status: "routed"; agent: DeployAgent; reason: string }
  | { status: "refused"; reason: string };

/**
 * The agent SPEC §2 routes a ticket with these labels to.
 *
 * Precedence is the SPEC's own: the pin is the "exception", so it wins over
 * the planning label (a `spec` ticket pinned `agent:codex` goes to codex),
 * and the planning labels win over the default.
 */
export function routeAgent(labels: readonly string[]): AgentRouting {
  const pins = [...new Set(labels.filter((label) => label.startsWith(PIN_PREFIX)))];
  if (pins.length > 1) {
    return {
      reason:
        `conflicting agent pins (${pins.join(", ")}): SPEC §2 pins ONE agent per ` +
        "ticket, and picking one of two would be a guess about which the author " +
        "meant; remove all but one label",
      status: "refused",
    };
  }
  const pin = pins[0];
  if (pin !== undefined) {
    const pinned = PINS[pin];
    if (pinned === undefined) {
      return {
        reason:
          `unknown agent pin '${pin}': Argus deploys claude, codex, and hermes, so ` +
          "this names no worker; SPEC §2's pins are 'agent:claude-code', " +
          "'agent:codex', and 'agent:hermes'",
        status: "refused",
      };
    }
    return { agent: pinned, reason: `pinned by '${pin}'`, status: "routed" };
  }

  // The planning half, read off the store that already holds it. Every
  // `GRILL_MODES` route names `claude`; the agent is taken from the row
  // rather than assumed, so a route that ever changed agent changes here too.
  for (const label of labels) {
    if (!isGrillMode(label)) continue;
    return {
      agent: GRILL_MODES[label].agent,
      reason: `planning label '${label}'`,
      status: "routed",
    };
  }

  return {
    agent: DEFAULT_AGENT,
    reason: "no planning label and no pin: an implementation ticket (SPEC §2's default)",
    status: "routed",
  };
}
