/**
 * Ticket #97 — invocability by the route the session actually uses.
 *
 * THE ASSERTION THAT CANNOT FAIL, and why none of these are it. `to-spec`
 * RESOLVES. It resolved for the whole time this bug shipped, and a test
 * asserting that it resolves would have been green throughout — that was never
 * the problem. What was unsatisfiable is the SENTENCE the session is handed:
 * "Use the `pocock-plus:to-spec` skill", a request for a model invocation of a
 * skill whose frontmatter forbids exactly that. So every case below asserts on
 * the FORM — what the dispatch prompt tells the session to do — or on the
 * refusal, and never on existence.
 *
 * The fixtures carry the two frontmatter keys separately because they are
 * separate surfaces, and both states exist on this machine today:
 * `disable-model-invocation: true` alone (`pocock-plus:to-spec`, slash-only)
 * and `user-invocable: false` alone (`codex:codex-cli-runtime`, model-only).
 * A skill with both is reachable by neither, and that is the refusal.
 *
 * That the slash form WORKS — that `claude` expands `/<id>` as the first
 * message of a session, for a `disable-model-invocation: true` skill, in this
 * exact multi-line shape, and carries the rest of the message to the model — is
 * not asserted here. It is a fact about the CLI, not about this repo, and it
 * was measured against the real binary: `docs/acceptance/grill-invocation-probe.txt`.
 */
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveGrillDispatch } from "./dispatch.ts";
import { fakeMachine, INSTALLED, withFrontmatter } from "./machine.fixture.ts";
import { grillPrompt } from "./prompt.ts";
import { GRILL_MODES, type GrillMode } from "./skills.ts";

const TOPIC = "the retro eye's scope-drift question";

/** The prompt the session is actually handed, for a mode on a given machine. */
async function promptFor(
  machine: { manifest: string; repo: string },
  mode: GrillMode,
): Promise<string> {
  const dispatch = await resolveGrillDispatch(machine.repo, mode, machine.manifest);
  if (dispatch.status !== "ready") throw new Error(dispatch.reason);
  return grillPrompt({ invocation: dispatch.invocation, ticket: "97", topic: TOPIC });
}

describe("resolveGrillDispatch (#97): the form, not the existence", () => {
  /**
   * THE BUG. `to-spec` resolves, so #89's check said "resolved" and the grill
   * started — against a prompt asking for a model invocation the frontmatter
   * forbids. The session did not fail; it did something adjacent.
   */
  test("a slash-only skill is dispatched as a slash command, not as a skill", async () => {
    const machine = await fakeMachine(withFrontmatter("to-spec", { slashOnly: true }));

    const dispatch = await resolveGrillDispatch(machine.repo, "spec", machine.manifest);

    expect(dispatch.status).toBe("ready");
    if (dispatch.status !== "ready") return;
    expect(dispatch.invocation.form).toBe("slash");

    const prompt = await promptFor(machine, "spec");
    // The id alone on the first line: the only shape `claude` expands.
    expect(prompt.split("\n")[0]).toBe("/pocock-plus:to-spec");
    // And the sentence that could never be honoured is GONE, which is the
    // whole of the fix as the session experiences it.
    expect(prompt).not.toContain("Use the pocock-plus:to-spec skill");
    // The charter survives the move; a slash command carries the skill, not
    // the reason for it.
    expect(prompt).toContain(`Use it to ${GRILL_MODES.spec.charter}.`);
    expect(prompt).toContain(TOPIC);
  });

  /**
   * The half that must NOT change. Three of the five modes were always
   * model-invocable, and their prompt is the one #62 recorded and §5 rule 1
   * hashes. A fix that rewrote all five would move the dispatch hash for the
   * modes that were working.
   */
  test("a model-invocable skill keeps the unchanged 'Use the X skill' sentence", async () => {
    const machine = await fakeMachine();

    const dispatch = await resolveGrillDispatch(
      machine.repo,
      "grilling",
      machine.manifest,
    );
    expect(dispatch.status).toBe("ready");
    if (dispatch.status !== "ready") return;
    expect(dispatch.invocation.form).toBe("skill");
    // §8.2's fallback, said out loud: no canonical copy, so the plugin id.
    expect(dispatch.invocation.skill).toBe("pocock-plus:grilling");
    expect(dispatch.invocation.source).toBe("pocock-plus");

    const prompt = await promptFor(machine, "grilling");
    expect(prompt.split("\n")[0]).toBe(
      `Use the pocock-plus:grilling skill and ${GRILL_MODES.grilling.charter}.`,
    );
  });

  /**
   * THE FRONTMATTER-CHANGE TEST, and the reason the decision is not a literal
   * in `GRILL_MODES`. Upstream drops `disable-model-invocation` from `to-spec`
   * and adds it to `grilling`: nothing in this repo is edited, and both modes
   * follow. A per-mode "spec is slash-only" field would have both backwards.
   */
  test("the form follows the frontmatter, in both directions, with no table edit", async () => {
    const flipped = await fakeMachine(withFrontmatter("grilling", { slashOnly: true }));

    const spec = await resolveGrillDispatch(flipped.repo, "spec", flipped.manifest);
    const grilling = await resolveGrillDispatch(
      flipped.repo,
      "grilling",
      flipped.manifest,
    );

    expect(spec.status === "ready" && spec.invocation.form).toBe("skill");
    expect(grilling.status === "ready" && grilling.invocation.form).toBe("slash");
    expect(await promptFor(flipped, "grilling")).toStartWith("/pocock-plus:grilling\n");
    // GRILL_MODES said nothing about either, and still says nothing.
    expect(Object.keys(GRILL_MODES.spec).sort()).toEqual([
      "agent",
      "charter",
      "name",
      "skill",
    ]);
  });

  /**
   * NEITHER SURFACE. `user-invocable: false` closes the command surface the
   * way `disable-model-invocation: true` closes the model's; a skill with both
   * cannot be reached at all, and `claude` offers no third way. Starting a
   * session against it is the silent wrong answer, so it is refused — by name.
   */
  test("a skill reachable by neither surface is refused, naming mode, id and reason", async () => {
    const machine = await fakeMachine(
      withFrontmatter("to-tickets", { modelOnly: true, slashOnly: true }),
    );

    const dispatch = await resolveGrillDispatch(
      machine.repo,
      "tickets",
      machine.manifest,
    );

    expect(dispatch.status).toBe("refused");
    if (dispatch.status !== "refused") return;
    expect(dispatch.mode).toBe("tickets");
    expect(dispatch.id).toBe("pocock-plus:to-tickets");
    expect(dispatch.reason).toContain("grill mode 'tickets'");
    expect(dispatch.reason).toContain("pocock-plus:to-tickets");
    expect(dispatch.reason).toContain("disable-model-invocation: true");
    expect(dispatch.reason).toContain("user-invocable: false");
  });

  /** A model-only skill is still dispatchable — the axes are independent. */
  test("user-invocable: false alone does not refuse; the model can still use it", async () => {
    const machine = await fakeMachine(withFrontmatter("to-spec", { modelOnly: true }));

    const dispatch = await resolveGrillDispatch(machine.repo, "spec", machine.manifest);

    expect(dispatch.status === "ready" && dispatch.invocation.form).toBe("skill");
  });

  /** #89's rename, now reaching the same refusal rather than a bare report. */
  test("a renamed skill is refused with the id that no longer resolves", async () => {
    const machine = await fakeMachine([
      ...INSTALLED.filter(({ name }) => name !== "to-spec"),
      { category: "engineering", name: "spec-it" },
    ]);

    const dispatch = await resolveGrillDispatch(machine.repo, "spec", machine.manifest);

    expect(dispatch.status).toBe("refused");
    if (dispatch.status !== "refused") return;
    expect(dispatch.reason).toContain("grill mode 'spec'");
    expect(dispatch.reason).toContain("does not resolve on this machine");
    expect(dispatch.reason).toContain("declares no skill named 'to-spec'");
  });

  /**
   * SPEC §8.2: the canonical store is the override, and it is read for the
   * FORM too — a repo that vendors a slash-only copy gets `/to-spec`, the bare
   * name, because that is the id the session would type.
   */
  test("the canonical store decides the form, and the id is its bare name", async () => {
    const machine = await fakeMachine();
    const canonical = join(machine.repo, ".argus", "skills", "to-spec");
    await mkdir(canonical, { recursive: true });
    await Bun.write(
      join(canonical, "SKILL.md"),
      "---\nname: to-spec\ndescription: the repo's own copy\ndisable-model-invocation: true\n---\n\nbody",
    );

    const dispatch = await resolveGrillDispatch(machine.repo, "spec", machine.manifest);

    expect(dispatch.status).toBe("ready");
    if (dispatch.status !== "ready") return;
    expect(dispatch.invocation.source).toBe("argus-canonical");
    expect(dispatch.invocation.form).toBe("slash");
    expect(await promptFor(machine, "spec")).toStartWith("/to-spec\n");
  });

  test("an unknown mode throws rather than dispatching a guessed skill", async () => {
    const machine = await fakeMachine();
    expect(
      resolveGrillDispatch(
        machine.repo,
        "sudo-make-me-a-sandwich" as GrillMode,
        machine.manifest,
      ),
    ).rejects.toThrow(/unknown grill mode/);
  });
});
