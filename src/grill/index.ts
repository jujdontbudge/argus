/**
 * Grill (ticket #62; SPEC §7.2): Johan's planning entry point — a REGISTERED,
 * attachable Claude session in a cmux workspace, opened with a routed planning
 * skill and announced to Johan.
 *
 * It composes on #55's `deployWorker` rather than duplicating it: the row is
 * durable before anything starts, by the same code that guarantees it for AFK
 * dispatch. The one substitution is how the session STARTS — typed into a cmux
 * workspace so §7.2 step 3 ("Johan answers in the terminal directly") is
 * possible at all — and that typing goes through #7's resolve-guard.
 *
 * Seams left open on purpose: nothing here reads the grill's output back.
 * Capturing the decisions is §7.2 step 3's other half and belongs to the five
 * watchers, which cover this session exactly as they cover any other
 * registered deployment.
 */
export {
  startGrill,
  type GrillOptions,
  type GrillRequest,
  type GrillResult,
} from "./grill.ts";
export {
  resolveGrillDispatch,
  type GrillDispatch,
  type GrillInvocation,
  type GrillInvocationForm,
} from "./dispatch.ts";
export {
  installedPluginSkills,
  verifyEveryGrillSkill,
  verifyGrillSkill,
  INSTALLED_PLUGINS_FILE,
  type GrillSkillVerification,
  type InstalledSkill,
  type SkillResolution,
} from "./installed.ts";
export {
  createCmuxLaunch,
  launchLine,
  shellQuote,
  type CmuxLaunchOptions,
} from "./launch.ts";
export { grillPrompt, type GrillPromptInput } from "./prompt.ts";
export { CLAUDE_GRILL_ROUTE } from "./route.ts";
export {
  DEFAULT_GRILL_MODEL,
  loadGrillConfig,
  resolveGrillModel,
  type GrillConfig,
} from "./config.ts";
export {
  GRILL_MODES,
  isGrillMode,
  type GrillMode,
  type GrillModeRoute,
  type ResolvedGrillSkill,
} from "./skills.ts";
