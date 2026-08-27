/**
 * CAN A SESSION ACTUALLY INVOKE THIS MODE'S SKILL? (ticket #97)
 *
 * #89 measured the hole and deliberately left it open, because closing it is a
 * choice rather than a repair: `pocock-plus:to-spec` and `pocock-plus:to-tickets`
 * carry `disable-model-invocation: true`. They exist, they resolve, they are
 * reachable as `/<id>` — and a MODEL cannot invoke them, while the dispatch
 * prompt says "Use the `<id>` skill". So the `spec` and `tickets` grills did
 * not fail. They started, read a sentence they could not honour, and carried on
 * doing something adjacent: `skills.ts`'s own documented hazard, reached by a
 * route its docblock did not anticipate.
 *
 * THE CHOICE MADE HERE, and what it rejects.
 *
 * #89 offered two: change the dispatch prompt for these two modes to invoke
 * them as slash commands, or change the route so these modes do not go through
 * model invocation at all. Both, written literally, encode "to-spec is
 * slash-only" as a CONSTANT on this side of the boundary — a per-mode field in
 * `GRILL_MODES`, or a per-mode branch in the route. That is the same shape as
 * the assertion #89 already caught being useless: a constant pinned against a
 * plugin that upstream can re-edit at any version bump, and this plugin has
 * already shipped three side by side on this machine. If upstream drops
 * `disable-model-invocation` from `to-spec`, a per-mode literal keeps typing a
 * slash command forever; if upstream ADDS it to `grilling` — the one mode
 * Johan runs most — a per-mode literal keeps saying "Use the skill" and the
 * silent-adjacent-answer failure simply moves to a different mode. Neither
 * option, as a literal, survives the next frontmatter change, which is the
 * version-drift class that produced all four attribution bugs.
 *
 * So: the MECHANISM is #89's option 1 — these modes are invoked as slash
 * commands — and the DECISION is not a literal. It is read at dispatch time
 * from the SKILL.md the session is actually going to load, through the
 * resolver #89 already built (`./installed.ts`). `GRILL_MODES` stays the single
 * source of truth for ROUTING (agent, name, id, charter) and gains nothing; the
 * machine stays the single source of truth for INVOCABILITY, which is the only
 * place that fact has ever been true. Add a mode, rename a skill, or take an
 * upstream frontmatter edit, and no table here needs to know.
 *
 * A third option was considered and rejected: drop `spec` and `tickets` off
 * the grill route entirely and leave Johan to type `/pocock-plus:to-spec`
 * himself. It works, it can never be wrong, and it deletes two links out of
 * SPEC §7.1's chain ("grilling → to-spec → to-tickets → implement"). A chain
 * missing its middle is not a fix; and it would leave the mechanism intact for
 * the next skill whose frontmatter changes, which is the actual defect.
 *
 * AND THE THIRD STATE, which is why this returns a refusal at all. The two
 * frontmatter keys are INDEPENDENT axes and both exist on this machine today:
 * `disable-model-invocation: true` closes the Skill tool (`pocock-plus:to-spec`),
 * `user-invocable: false` closes the `/<id>` command surface (`codex:codex-cli-runtime`).
 * A skill carrying both is reachable by neither, and there is no third way into
 * a `claude` session. That mode cannot work, and the session must not start:
 * a started session with an unsatisfiable first sentence is exactly the silent
 * wrong answer #97 is about. It is refused here, by name — the mode, the id and
 * the reason — before a cmux tab is opened or a registry row is written.
 */
import { verifyGrillSkill } from "./installed.ts";
import { GRILL_MODES, type GrillMode, type ResolvedGrillSkill } from "./skills.ts";

/** How the session is told to reach the skill — the two `claude` offers. */
export type GrillInvocationForm =
  /** The Skill tool: "Use the `<id>` skill". Needs model invocation. */
  | "skill"
  /** `/<id>` as the session's first message. Needs the command surface. */
  | "slash";

export interface GrillInvocation extends ResolvedGrillSkill {
  form: GrillInvocationForm;
  /** The SKILL.md the decision was read from, so a report can cite it. */
  path: string;
}

export type GrillDispatch =
  | { status: "ready"; invocation: GrillInvocation }
  /** Names the mode, the id and the reason. Nothing has been started. */
  | { status: "refused"; mode: GrillMode; id: string; reason: string };

/**
 * Resolve one mode into the invocation the session will actually use, or
 * refuse it.
 *
 * Precedence is `verifyGrillSkill`'s — SPEC §8.2's canonical `.argus/skills/`
 * first, the plugin id as the fallback — and it is called rather than repeated
 * so the resolution the refusal is about is the resolution the prompt gets.
 */
export async function resolveGrillDispatch(
  repo: string,
  mode: GrillMode = "grilling",
  manifestFile?: string,
): Promise<GrillDispatch> {
  if (!Object.hasOwn(GRILL_MODES, mode)) {
    throw new Error(
      `unknown grill mode '${mode}'; known modes: ${Object.keys(GRILL_MODES).join(", ")}`,
    );
  }
  const verified =
    manifestFile === undefined
      ? await verifyGrillSkill(repo, mode)
      : await verifyGrillSkill(repo, mode, manifestFile);

  if (verified.resolution.status === "missing") {
    return {
      id: verified.id,
      mode,
      reason:
        `grill mode '${mode}' routes to skill '${verified.id}', which does not ` +
        `resolve on this machine: ${verified.resolution.reason}`,
      status: "refused",
    };
  }

  const { skill, source } = verified.resolution;
  if (skill.modelInvocable) {
    return {
      invocation: { form: "skill", mode, path: skill.path, skill: verified.id, source },
      status: "ready",
    };
  }
  if (skill.userInvocable) {
    return {
      invocation: { form: "slash", mode, path: skill.path, skill: verified.id, source },
      status: "ready",
    };
  }
  return {
    id: verified.id,
    mode,
    reason:
      `grill mode '${mode}' routes to skill '${verified.id}', which resolves at ` +
      `${skill.path} but no session can invoke it: its frontmatter carries both ` +
      `disable-model-invocation: true (a model cannot use the skill) and ` +
      `user-invocable: false (there is no /${verified.id} command)`,
    status: "refused",
  };
}
