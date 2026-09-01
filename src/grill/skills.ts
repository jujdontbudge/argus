/**
 * Skill routing for the grill flow (ticket #62) — SPEC §1's routing table and
 * §7.1's chain, made executable.
 *
 * SPEC §1: "Routing is by ticket label. `grilling`, `spec`, `tickets`, `review`,
 * `diagnosis` → Claude Code; implementation tickets (default) → Codex." SPEC
 * §7.1: the chain is "the Matt Pocock chain as shipped by pocock-plus:
 * `grilling → to-spec → to-tickets → implement`, with `wayfinder` for
 * multi-session maps and `code-review` at the end".
 *
 * Two things this module refuses to leave implicit.
 *
 * **The agent is part of the route, not a default.** A grill mode routed to
 * the implementer would be a planning session run by an agent whose whole job
 * is to write code, and nothing downstream would look wrong. So every mode
 * names `claude` and the table is asserted, rather than the CLI hard-coding it
 * once and hoping.
 *
 * **The skill NAME is part of the route too.** `claude` given a skill id that
 * does not exist does not fail — it carries on and does something adjacent,
 * which is the worst possible failure for a planning entry point. The plugin
 * ids below were read off this machine's installed pocock-plus (1.2.3-johan.7,
 * `skills/engineering/` and `skills/productivity/`) rather than inferred from
 * the SPEC text, and `skills.test.ts` pins them by name so an upstream rename
 * breaks a test instead of a grill.
 *
 * Precedence is §8.2's — "canonical store `.argus/skills/`, SKILL.md format …
 * one store, three readers, no forks". When the repo's canonical store already
 * carries the skill (the Reviewer writes there, the curator retires from
 * there), that copy is what the session should read, and Claude reaches it
 * through the `.claude/skills -> ../.argus/skills` symlink `argus up` writes.
 * The plugin id is the fallback, never the override.
 *
 * That precedence used to be implemented twice — once here as
 * `resolveGrillSkill`, once in `./installed.ts` as `verifyGrillSkill` — and the
 * copy here could not see frontmatter, so its answer for `spec` was
 * "resolved: pocock-plus:to-spec", which is the wrong answer #97 is about. It
 * was deleted rather than kept in step: this module now holds the TABLE, and
 * `./dispatch.ts` holds the one resolution the session is dispatched against.
 */
export type GrillMode =
  /** §7.2 itself: Johan is grilled about X for repo R. */
  | "grilling"
  /** The grilling output becomes a spec (§7.1). */
  | "spec"
  /** The spec becomes tickets (§7.1). */
  | "tickets"
  /** §1's `review` label. */
  | "review"
  /** §1's `diagnosis` label. */
  | "diagnosis";

export interface GrillModeRoute {
  /** SPEC §1: all five planning labels route to Claude Code, never Codex. */
  agent: "claude";
  /** The bare skill name, as it appears in a canonical `.argus/skills/`. */
  name: string;
  /** The plugin-qualified id used when the canonical store has no copy. */
  skill: string;
  /** One line for the dispatch prompt, so the session knows what it is for. */
  charter: string;
}

export const GRILL_MODES: Readonly<Record<GrillMode, GrillModeRoute>> = {
  diagnosis: {
    agent: "claude",
    charter: "diagnose the problem before anyone proposes a fix",
    name: "diagnosing-bugs",
    skill: "pocock-plus:diagnosing-bugs",
  },
  grilling: {
    agent: "claude",
    charter: "grill Johan until the thinking holds up",
    name: "grilling",
    skill: "pocock-plus:grilling",
  },
  review: {
    agent: "claude",
    charter: "review the work against what it claimed to do",
    name: "code-review",
    skill: "pocock-plus:code-review",
  },
  spec: {
    agent: "claude",
    charter: "turn the decisions into a spec",
    name: "to-spec",
    skill: "pocock-plus:to-spec",
  },
  tickets: {
    agent: "claude",
    charter: "cut the spec into tickets",
    name: "to-tickets",
    skill: "pocock-plus:to-tickets",
  },
};

export interface ResolvedGrillSkill {
  mode: GrillMode;
  /** The id the dispatch prompt invokes. */
  skill: string;
  source: "argus-canonical" | "pocock-plus";
}

export function isGrillMode(value: string): value is GrillMode {
  return Object.hasOwn(GRILL_MODES, value);
}
