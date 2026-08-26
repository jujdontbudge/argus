/**
 * Ticket #54 evaluation corpus — REAL turns, verbatim, from this machine.
 *
 * Every entry is copied byte-for-byte out of a real transcript under
 * `~/.claude/projects/-Users-johansardar-argus/`, keeping its real uuid,
 * timestamp and session id, so a human can re-read the source line with
 *   grep <uuid> ~/.claude/projects/-Users-johansardar-argus/*.jsonl
 * and check the ground truth without rerunning anything.
 *
 * `author` is the provenance verdict the classifier would produce for that
 * record given the registry: Johan's own typed messages are `johan`, the
 * dispatcher's relayed directives are `hermes`, agent output is the agent.
 * Provenance classification is NOT under test here — the brain tier is —
 * so the authors are fixed and correct by construction.
 */
import type { ProvenanceRecord } from "../../../../src/provenance";

export interface Turn {
  uuid: string;
  ts: string;
  session: string;
  role: "user" | "assistant";
  author: ProvenanceRecord["author"];
  text: string;
}

const S_MONITOR = "0a3ac707-b3db-412d-9744-0260a0ba08ff";
const S_DISPATCH = "878bcaaa-79ca-4c26-8cd2-e735e5dbf249";

export const TURNS: Record<string, Turn> = {
  // ---- Johan-authored, typed (author=johan) ----
  tabsNotWorkspaces: {
    uuid: "68714bd8-a740-422c-a02d-a077db5beb33",
    ts: "2026-08-24T18:17:33.090Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "ok there is way to much shit going on firts of all when a agent is spawn it need to spawn in teh in the ewn workspace as a new tab. not  new workspace. you are spawning htem in a new worksapce. plase do not do this. second of all the tabs or wokrpxaces need to close fully when done. please mointoir evyerhing going right now. let ones that are currnely going ifnsih. cut all of the rest hat are finisehd pracice and make sure you can spawn in new tab. evreify by screenshoting the acutla screen. then form now on. do that there is jsut ay to many workpasces spawning in.",
  },
  testingPolicy: {
    uuid: "cadb625e-9f16-4966-a027-13f40454705f",
    ts: "2026-08-24T18:25:37.690Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "also making sure tesong for hte system happens using opus 5 in isloaiton and codex sol high in isloiaotn for any testing update this where it need to be. also can ic lsoe all teh sesion that arnt working?",
  },
  opusMaxNoFable: {
    uuid: "00e8d0e9-f00d-4c3c-92f1-7ca73c996c65",
    ts: "2026-08-25T15:43:13.314Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "from now change somehting all dlepoy claode cod eagent will be opus max no fable nothign will be fable",
  },
  noAnthropicApi: {
    uuid: "9792035e-2532-4744-b6f2-2c17bbf924ea",
    ts: "2026-08-25T23:44:31.474Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "i can never use a antrpic model via api bc subsciproint doesn allow that so ocnsider alt aht uncoaibly uselses",
  },
  loopDesign: {
    uuid: "211fec13-a085-48a5-a6f1-16c350165035",
    ts: "2026-08-24T15:39:14.651Z",
    session: S_DISPATCH,
    role: "user",
    author: "johan",
    text: "i want to start a loop in bit that lops until eveyrhting is finished. it kicks of a tikcet at a time. and spawn agents in new tiernal to do this. it will have one codex and one fable agent running at alltimes. it will spawn themusing hte cmux skill in here. you will hand off grilling ticket that i ened to work with or any reach plann atrehcure deisgn tickets to fable. and all excution tickets give to codex sol high fast \n\n\ndo you udnetand?",
  },
  // ---- Johan-authored, transient: the correct answer is NOTHING durable ----
  askLoopRunning: {
    uuid: "9f860666-a5a2-43d3-b989-26fcebc7f40d",
    ts: "2026-08-24T19:03:10.523Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "so evyer tick will start in a cleared context new sesion right?",
  },
  askCmuxTiming: {
    uuid: "b7cbbcf0-95a8-4d38-a9b1-53f625f0b5d9",
    ts: "2026-08-25T04:33:23.383Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "do i have to upgrade cmux now or can this be odne at end",
  },
  askAnythingNeedsMe: {
    uuid: "22a0c52d-e9a7-4050-90af-29f2a5212cfc",
    ts: "2026-08-26T03:58:01.831Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "i will od hta lter forget. now get the rest of theis thing fully built nothing needs me right?",
  },
  askAreYouSure: {
    uuid: "3bf8f630-088c-4b8a-b186-b8b9b52c222e",
    ts: "2026-08-24T22:23:22.854Z",
    session: S_MONITOR,
    role: "user",
    author: "johan",
    text: "damm are you sure that it? this inlud building test amkin sure it works edges tdd making evyerhting asplguins making sure allcopamdn and steupst work live test etc?",
  },
  // ---- Hermes-relayed: quotes Johan but is NOT Johan-authored (USER.md trap) ----
  relayedNeverReuse: {
    uuid: "e2bf6f32-543b-4bfe-b999-a8d144587c6a",
    ts: "2026-08-24T18:51:17.816Z",
    session: S_DISPATCH,
    role: "user",
    author: "hermes",
    text: "JOHAN CLARIFICATION (relayed): a worker tab/session is NEVER reused for a new ticket — when a ticket finishes, close its tab (fresh: you already did this for #11), and every new ticket gets a brand-new tab with a brand-new claude/codex process launched fresh; never type a new ticket prompt into a Claude that already worked a ticket. This matches your current recipe — add the explicit 'never reuse a finished worker session' line to loop-state.md so it can never regress.",
  },
  // ---- Agent output (author=claude-code): project facts, and USER.md traps ----
  asstEchoOpusMax: {
    uuid: "9e4742d4-6cee-462e-94fd-e0c5b1c78426",
    ts: "2026-08-25T15:43:43.168Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "Understood — **no more Fable workers: every Claude Code agent the loop deploys runs Opus at max effort from now on.** Pushing it into the dispatcher, including respawning the just-started #31 (it's minutes old, so nothing is lost):",
  },
  asstOpusFlagsVerified: {
    uuid: "3f3601d9-33d5-401e-9b2d-9a2327be72b5",
    ts: "2026-08-25T15:45:36.467Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "Confirmed and verified at the process level: the first Opus worker is live with exactly `--model claude-opus-5 --effort max` — the flag took, no fallback needed. And the loop kept scoring while the switch happened: **#29 (supervisor) and #31 (Digest eye) both closed, making 10 of 18 build tickets done.** Lanes right now: codex on **#26 (archiver + `argus search`)**, Opus on **#33 (Retro eye)** — tab convention updated to \"(opus)\". Left in the build: #22/#23 (Codex & Hermes tailing sources), #32 (Honcho eye), #34 (events + push hooks), #35 (curator), and #36 — the final live acceptance with all ten scenarios. Fable is fully out of the fleet; the only Fable session left anywhere is me.",
  },
  asstCmuxVersion: {
    uuid: "136f4906-ef11-49ba-87fa-00f0752f65a5",
    ts: "2026-08-25T19:06:06.570Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "Two things. That's it.\n\n**1. Upgrade cmux — 2 minutes.** Press ⌘Q to fully quit cmux (not just close the window), then reopen it. If the \"Update installed · Restart to update\" banner is still there afterward, click that banner directly. Verify by running `cmux version` — you want ≥0.64.22, not 0.62.2. Everything reopens and the loop keeps going; the dispatcher will detect the new version, close #15, and dispatch #7 on its own. Without this, v1 can never be fully proven, because one of the ten acceptance scenarios can't run.",
  },
  asstHeadlessMode: {
    uuid: "fd7f79fa-6b77-4d2b-9420-15507f47300f",
    ts: "2026-08-25T17:17:33.666Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "Headless mode is working — your call paid off immediately. **Three workers launched** (#23 Hermes tailing source, #34 events + push hooks, #35 curator), running as detached background processes writing to logs in their worktrees, and they're actively producing output right now (the Hermes-source worker is already 2,891 lines deep). No cmux restart needed, no tabs required, throughput restored.",
  },
  asstFreshContext: {
    uuid: "0dd1b733-079f-498e-a3bc-ea8f319a32c8",
    ts: "2026-08-24T19:03:39.990Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "**Yes — verified on disk, not just in theory.** The #10 worker that just spawned is session `f847fa02`, a transcript file that did not exist before 1:49 PM, and its very first message is its ticket brief: *\"You are the Fable research worker… you work EXACTLY ONE ticket, then stop: ticket #10.\"* Nothing before it. No #11 history, no dispatcher chatter, no other tickets — a completely fresh context.",
  },
  asstOrphanedTickets: {
    uuid: "b1ce4b37-9100-4799-ac5c-1dbcd9535400",
    ts: "2026-08-25T19:53:47.626Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "**One ticket is genuinely running: #39** (implement `argus watch <eye>` for all five eyes), a Codex worker 11 minutes in, with real commits in its worktree.\n\nBut I found a problem while checking. **#38 and #40 are marked claimed but have no live process** — they're orphaned. Both did real work before vanishing: the scope-drift worktree has a spec commit (\"v1 detects in-ticket scope drift (§14)\") and the status-temp worktree has the supervisor fix committed. So they either finished and their closure step silently failed — the same failure mode that idled a lane for 2.6 hours yesterday — or they died mid-task after committing.",
  },
  asstStatusNarrative: {
    uuid: "05a8b12e-dec2-402f-a010-6af5efc90f91",
    ts: "2026-08-25T18:08:50.511Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "**Nearly there: 17 of 18 build tickets are done.** #35 (curator pass) closed, and the only ticket left is **#36 — the v1 live acceptance run**, which is executing right now as a healthy headless worker (PID alive, 4 minutes in). The dispatcher smartly pre-loaded its brief with already-verified facts so it spends its time proving rather than re-deriving.",
  },
  asstWatchdogRestart: {
    uuid: "16b138ea-f5bf-4ed2-9f86-7aefc9ca385b",
    ts: "2026-08-25T22:19:55.444Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "Watchdog restarted (it crashed on a bad process check — my bug, now replaced with a version that uses the dispatcher's loop-state file as the loop's heartbeat instead of trying to fingerprint worker processes among your ~15 Claude sessions).\n\nProgress in the meantime: **#43, #44 and #45 all closed**, and the agent-doable gate I asked for got filed as **#47** — \"Hermes live verification silently skips forever (no profile exists to read),\" which is the Hermes half of the environment blockers.",
  },
  asstTabHygiene: {
    uuid: "c2b83ece-1e62-40b1-886e-817f6c6087aa",
    ts: "2026-08-24T23:19:03.613Z",
    session: S_MONITOR,
    role: "assistant",
    author: "claude-code",
    text: "Both lanes are saturated and building — the loop is fully back in motion:\n\n- **18 build tickets** cut under map #18, covering the spec's implementation surface.\n- **Codex lane**: #19 (argus CLI skeleton) — working now.\n- **Fable lane**: #24 (send-matcher implementation, straight from #11's research) — working now.\n- Dispatcher on its 5-minute cadence, watchdog armed, tab hygiene clean (exactly four tabs: monitoring, dispatcher, two workers).",
  },
  // ---- Worker session 603b50b3 (ticket #38 scope-drift build) — Digest arc ----
  w38Brief: {
    uuid: "ca974261-deb8-4953-bbc2-22b0f41dcb1a",
    ts: "2026-08-25T19:10:15.385Z",
    session: "603b50b3-f6c2-4de4-b17d-aebb1ae33b81",
    role: "user",
    author: "hermes",
    text: "You are an Opus BUILD worker for the Argus v1 build map \u2014 repo JohanSardar/argus, build map issue #18. You implement EXACTLY ONE ticket, then stop: ticket #38 \"build: retro scope-drift signal (SPEC \u00a714 in-ticket case)\" (already claimed for you).\n\nThis ticket exists because Johan decided it: the SPEC \u00a714 harder case is IN SCOPE for v1 (\"build it for v1\"). It was raised as #37 and cut into #38.\n\nYour working tree is ~/argus-worktrees/scope-drift on branch build/scope-drift, branched off main @ 6fa86ec. Work ONLY in this worktree. Read first: your ticket, the closed #37 for the reasoning behind the decision, SPEC.md \u00a714 and \u00a712, and \u2014 most importantly \u2014 `src/eyes/retro/` IN FULL. The signal \u2192 compose \u2192 tracker-filing plumbing already exists. **EXTEND it. Do not duplicate it, and do not add a sixth watcher.**",
  },
  w38Start: {
    uuid: "d2c89e66-fe43-45c7-9695-ec3e8a43e3af",
    ts: "2026-08-25T19:10:22.097Z",
    session: "603b50b3-f6c2-4de4-b17d-aebb1ae33b81",
    role: "assistant",
    author: "claude-code",
    text: "I'll start by reading the ticket, the decision context, and the existing retro eye code.",
  },
  w38Green4: {
    uuid: "7ae319f3-6c64-4427-a37a-4ce8c318e1c7",
    ts: "2026-08-25T19:35:56.598Z",
    session: "603b50b3-f6c2-4de4-b17d-aebb1ae33b81",
    role: "assistant",
    author: "claude-code",
    text: "**Slice 4 \u2014 red:** `decideDrift`, the encoded false-positive policy. Both directions.",
  },
  w38AllGreen: {
    uuid: "5a4586ff-813d-4c31-846d-1a6a82df8e33",
    ts: "2026-08-25T19:46:29.351Z",
    session: "603b50b3-f6c2-4de4-b17d-aebb1ae33b81",
    role: "assistant",
    author: "claude-code",
    text: "All 8 drift cases green. Full retro suite + typecheck:",
  },
  w38Spec: {
    uuid: "09b305e9-4f6a-498b-b7e8-cc3133a29384",
    ts: "2026-08-25T19:52:07.040Z",
    session: "603b50b3-f6c2-4de4-b17d-aebb1ae33b81",
    role: "assistant",
    author: "claude-code",
    text: "**Slice 10 \u2014 the SPEC.** \u00a714 must say what ships, including the false-positive stance:",
  },
  w38Final: {
    uuid: "318d8036-d693-42f4-b49e-c6251b06f499",
    ts: "2026-08-25T20:20:28.250Z",
    session: "603b50b3-f6c2-4de4-b17d-aebb1ae33b81",
    role: "assistant",
    author: "claude-code",
    text: "Ticket #38 built and committed to `build/scope-drift`; comment posted.\n\n**What shipped:** a third Retro-eye signal that feeds on the *other* half of attribution \u2014 the work a registered ticket session **does** cover \u2014 and asks one brain question: is this diff what the ticket asked for? It reuses the existing git scan's worktree\u2192parent mapping and evidence caps, reads stated scope through the existing `gh` seam (closed tickets included), and files through the existing compose + tracker path. No sixth watcher, no new brain, no new model tier.\n\n**The false-positive stance is in both halves:** stated in the prompt (burden of proof on drift, named safe list, ambiguity \u2192 silence, cost asymmetry spelled out) and enforced in `decideDrift` \u2014 two booleans plus articulated prose, or nothing files. A scope too thin to measure against never reaches the brain.\n\n**Gates green** on current main: `bun x tsc --noEmit` exit 0; `bun test` 571 pass / 2 skip / 0 fail.\n\nThree things worth your attention:\n\n1. **The live-luna test passed both directions.** It builds the real prompt via `buildDriftPrompt`, and luna at `low` effort called the refactor in-scope and the billing webhooks drift \u2014 with the schema accepted, no bare `exit 1`. `schema.test.ts` also walks the whole schema asserting `required` == `properties` at every node, so #35's lesson can't regress.\n\n2. **One fix beyond the ticket text:** a `Brain` that *throws* rather than returning `ok: false` escaped the drift pass and would have taken the watcher down. Now it degrades to the same audited silence, cap slot released on every path. Red test first, last commit.\n\n3. **`all-scenarios.ts` was on main** when I rebased (#36 landed mid-flight, and #40 after), so I registered there \u2014 both directions pinned in `CONTRIBUTED[2]`. My half chains slot 2 via `registry.get(2)`; #36's ordering already runs retro among the extenders, so it survives.\n\nNot merged, ticket left open, main and other worktrees untouched.\n\nDONE",
  },
};

export function turn(key: keyof typeof TURNS): Turn {
  const found = TURNS[key];
  if (found === undefined) throw new Error(`unknown turn ${String(key)}`);
  return found;
}
