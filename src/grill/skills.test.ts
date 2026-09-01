import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { GRILL_MODES } from "./index.ts";

/**
 * Ticket #62 — skill routing, SPEC §1 ("`grilling`, `spec`, `tickets`, `review`,
 * `diagnosis` → Claude Code") and §7.1 (the pocock-plus chain).
 *
 * Routing has two halves and both are asserted here, because getting either
 * one wrong is silent: a mode routed to the wrong AGENT sends planning work to
 * the implementer, and a mode routed to a skill NAME that does not exist opens
 * a session that quietly does something else and looks fine.
 *
 * §8.2's "one store, three readers" decides the precedence: when the repo's
 * canonical `.argus/skills/` carries the skill, that copy wins, because it is
 * the one the Reviewer updates and the curator retires. The plugin id is the
 * fallback, never the override.
 *
 * #97 moved the RESOLUTION cases out of this file. They asserted
 * `resolveGrillSkill`, a second implementation of §8.2's precedence that could
 * not read frontmatter and therefore answered "resolved: pocock-plus:to-spec"
 * for a skill no session could invoke. The function is gone and the three
 * assertions live in `dispatch.test.ts` against `resolveGrillDispatch` — the
 * resolver production actually dispatches through — where each one now also
 * has to say what FORM the session is given. What stays here is the TABLE:
 * the one thing this module still owns.
 */
describe("GRILL_MODES (#62): SPEC §1's routing table and §7.1's chain", () => {
  test("every routed mode names a real pocock-plus skill and routes to Claude", () => {
    for (const [mode, route] of Object.entries(GRILL_MODES)) {
      expect(route.agent).toBe("claude");
      expect(route.skill).toMatch(/^pocock-plus:[a-z-]+$/);
      expect(route.skill.slice("pocock-plus:".length)).toBe(route.name);
      expect(mode).not.toBe("");
    }
    // SPEC §7.1's chain, by name, so a rename upstream fails here loudly
    // instead of opening a session on a skill that is not there.
    expect(GRILL_MODES.grilling.skill).toBe("pocock-plus:grilling");
    expect(GRILL_MODES.spec.skill).toBe("pocock-plus:to-spec");
    expect(GRILL_MODES.tickets.skill).toBe("pocock-plus:to-tickets");
  });

  test("SPEC §2 names every GRILL_MODES route as Claude planning work", async () => {
    const spec = await Bun.file(join(import.meta.dir, "../../SPEC.md")).text();

    expect(spec).toContain(
      "| **Claude Code** | Claude subscription, `claude-fable-5` (Fable) | Grilling, specs, tickets, domain modeling, diagnosis, code review. |",
    );
    expect(spec).toContain(
      "- `grilling`, `spec`, `tickets`, `review`, `diagnosis` → Claude Code",
    );
  });

});
