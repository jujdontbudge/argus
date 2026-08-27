# Gate × evidence map

Ticket #101. Audited 2026-08-26 against `build/evidence-audit` @ `4a49096`
(merge of #100, the newest commit on `main`).

**Why this file exists.** Twelve `ARGUS_LIVE_*` gates and nineteen files in
`docs/acceptance/`, and until this file the mapping between them lived nowhere.
#84 recorded seven gates as never-run because it grepped for gate *names*
instead of reading `docs/acceptance/`. The absence of the mapping is what let
that happen, so the mapping is the deliverable — not a summary of it.

**A GitHub comment is not evidence.** It does not survive `git clone`, it is not
in the tree the tests live in, and it cannot be diffed when a claim changes.
Where a gate's only record was a ticket comment, the durable substance is
transcribed into `docs/acceptance/` by this ticket and marked, in the file
itself, as transcribed rather than freshly measured.

## Status vocabulary

Not invented here. `gate-unset` / `not-run` / `run` are #43's, declared as
`LiveHalfStatus` in `src/harness/live-gate.ts:52-58` and rendered by
`LIVE_HALF_BANNER` as `SKIPPED` / `NOT RUN` / `RUN`:

| status | banner | means |
| --- | --- | --- |
| `gate-unset` | SKIPPED | Nobody asked for a live call, so nobody paid for one. |
| `not-run` | NOT RUN | Asked for, and a CLI or credential this half needs is absent. |
| `run` | RUN | The half actually executed. |

These grade a **half of a gated drive**, at the moment that drive runs. They are
not a grade of the *evidence*, which is what this file adds. #63's
**STRUCTURAL** vs **LIVE** (`src/harness/verdicts.ts`) is the related and
distinct axis: it grades a §13 *scenario*, and LIVE is unreachable by
declaration — it requires `recordLiveEvidence`, reachable only from code that
spawned an agent. A gate reaching `run` does **not** make a slot LIVE. #77 and
#78 both reached `run` and left every slot STRUCTURAL, on purpose.

Two columns below are this ticket's, and neither is #43's vocabulary:

- **Ever run** — has this gate ever reached `run` on this machine, per a record
  that survives a clone.
- **Evidence currency** — does that record still describe the code in the tree.
  `CURRENT` / `STALE` / `PARTLY STALE`, with the reason named.

---

## The 12 × 1 mapping

| # | Gate | Declared at | Ever run | Evidence lives | Currency |
| --- | --- | --- | --- | --- | --- |
| 1 | `ARGUS_LIVE_AGENTS` | `src/harness/live-gate.ts:34` | yes — #36, 2026-08-25 | `live-agent-drive.txt`, `live-command-sweep.txt` | **STALE** |
| 2 | `ARGUS_LIVE_BATCH_SEARCH` | `src/harness/batch-search.ts:113` | yes — #92, 2026-08-26 19:52 | `batch-and-search.txt` | CURRENT |
| 3 | `ARGUS_LIVE_CLAUDE_SUBSCRIPTION` | `src/harness/subscription-gate.ts:47` | yes — #55, and #83 | `deploy-primitive.txt`, `full-journey-e2e.txt` | **STALE** |
| 4 | `ARGUS_LIVE_CMUX` | `src/harness/cmux-door.ts:62` | yes — #90, 2026-08-26 18:07 | `cmux-door.txt` | CURRENT |
| 5 | `ARGUS_LIVE_CODEX_DEPLOY` | `src/deploy/live.test.ts:54` — **a test file** | yes — #55 | `deploy-primitive.txt` | **STALE** |
| 6 | `ARGUS_LIVE_FULL_JOURNEY` | `src/harness/full-journey.ts:125` | yes — #83, 2026-08-26 13:04 | `full-journey-e2e.txt` | **STALE** |
| 7 | `ARGUS_LIVE_GRILL` | `src/harness/grill-live.ts:110` | yes — #89, 2026-08-26 17:37 | `grill-live.txt` | **PARTLY STALE** |
| 8 | `ARGUS_LIVE_HERMES` | `src/harness/hermes-live-gate.ts:36` | yes — #47, 2026-08-25; `real` half **`not-run`** | `hermes-live.txt` | **STALE** |
| 9 | `ARGUS_LIVE_HONCHO` | `src/eyes/live-gate.ts:7` | yes — #76, 2026-08-26 10:50 | **was comment-only** → `honcho-isolation-live.txt` (transcribed by #101) | **TRANSCRIBED** |
| 10 | `ARGUS_LIVE_LAUNCHD_SMOKE` | `src/supervisor/launchd-live-gate.ts:3` | yes — #85, 2026-08-26 15:41 | `launchd-live-smoke.txt` | CURRENT |
| 11 | `ARGUS_LIVE_SLOTS` | `src/harness/live-slots.ts:101` | yes — #78, 2026-08-26 11:26 | **was comment-only** → `live-slots-drive.txt` (transcribed by #101) | **TRANSCRIBED** |
| 12 | `ARGUS_LIVE_WATCHER_BRAINS` | `src/eyes/live-gate.ts:6` | yes — #77, then re-run by #91 | `watcher-brains-correct.txt` (#91); #77's distinct earlier run → `watcher-brains-doubles.txt` (transcribed by #101) | CURRENT (#91) |

**All twelve gates have been run at least once.** None is `not-run` or never-run
at the whole-gate level. The gap this ticket was filed against is not
un-run gates — it is un-durable and out-of-date records, and two of the three
comment-only records are now files.

---

## The mapping is not one-to-one, in four specific ways

The ticket asks whether the 12 gates and the 19 files map one-to-one. They do
not, and the ways they fail to are load-bearing.

1. **One file can be the only evidence for two gates.** `deploy-primitive.txt`
   is the record for both `ARGUS_LIVE_CLAUDE_SUBSCRIPTION` and
   `ARGUS_LIVE_CODEX_DEPLOY` — one command line opened both
   (`ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1 ARGUS_LIVE_CODEX_DEPLOY=1 bun test
   src/deploy/live.test.ts`). Re-running one re-runs the other.

2. **One gate opens another.** `resolveSubscriptionGate`
   (`src/harness/subscription-gate.ts:88-97`) is opened by **either**
   `ARGUS_LIVE_CLAUDE_SUBSCRIPTION` **or** `ARGUS_LIVE_AGENTS`, and reports
   which in `openedBy` precisely so whoever spent the call knows what spent it.
   This is the only implicit composition edge in the twelve.
   `ARGUS_LIVE_FULL_JOURNEY` deliberately does *not* inherit #43's gate —
   `full-journey.ts:124` says so in a comment. `full-journey-e2e.txt`'s
   "composed gates" line records three variables the **operator** set by hand,
   not an implication in the code.

3. **Seven of the 19 files answer no gate at all.** `gates-worktree.txt` (#87),
   `grill-invocation-probe.txt` (#97), `grill-modes-red.txt` (#97),
   `hermes-orchestrator-e2e.txt` (#82), `init-up-e2e.txt` (#73),
   `scenario-evidence.txt` (#45), `shape-drift-probe.txt` (#100),
   `silent-deploy.txt` (#96) and `watch-stability.txt` (#45) are acceptance
   records for ungated work. They are not gate evidence and counting them
   against the twelve is the arithmetic that makes the gate coverage look
   better than it is.

4. **Two gates have no committed runner.** `ARGUS_LIVE_GRILL` and
   `ARGUS_LIVE_BATCH_SEARCH` are driven by exported library functions —
   `runGrillLive` (`src/harness/grill-live.ts:396`) and `runBatchAndSearch`
   (`src/harness/batch-search.ts:679`) — with no `import.meta.main` entry and no
   script under `scripts/acceptance/`. Every other gate is opened by naming a
   test file. #100 committed `scripts/acceptance/shape-drift-probe.ts` and put a
   `Reproduce:` line at the top of its evidence; these two cannot be reproduced
   from the tree without writing a runner first. **That is a reproducibility
   gap, not a coverage gap** — the runs happened, they just cannot be repeated
   by reading the repo.

---

## What is STALE, and why

Ten merges landed on `main` on 2026-08-26 between 16:43 and 20:23, and several
changed the exact code paths older evidence describes. In merge order:

| time | merge | what moved |
| --- | --- | --- |
| 16:43 | #94 | the orchestrator skill is installed into the canonical store |
| 16:43 | #95 | a deployed session is a cmux **TAB**, never a workspace; `src/deploy/workspace.ts` **deleted** |
| 17:37 | #89 | the launch line carries `cwd`; fixed a #95 regression where a sandbox grill ran in the **real** `~/argus` |
| 18:07 | #90 | cmux **refs fail OPEN, UUIDs fail CLOSED** — an unresolvable ref is a redirect onto the focused surface, exit 0 |
| 18:07 | #91 | the watcher-brain gate grades the **answer**, not the parse |
| 19:22 | #96 | pre-trust the worktree; silent deployment becomes visibly degraded |
| 19:52 | #92 | SPEC §14 bullets 2 and 4 driven live |
| 19:52 | #97 | dispatch reads a skill's **invocation form** off the file |
| 20:23 | #100 | record-shape canary that fires on UNKNOWN shape |

An evidence file written before a merge describes code that no longer exists.
Per gate:

**`ARGUS_LIVE_AGENTS` — STALE.** `live-agent-drive.txt` and
`live-command-sweep.txt` were run 2026-08-25 and last touched at `bbb317a`, a
full day and ~25 merges before the wave above. The drive they record deploys a
Codex session through the deployment primitive as it stood before #95 replaced
workspace creation with `openWorkerTab`, before #96 inserted the pre-trust step
into `deployWorker`, and before #89 put `cwd` on the launch line. The recorded
Codex session id and rollout path are still true statements about 2026-08-25;
they are no longer a description of what `deployWorker` does.

**`ARGUS_LIVE_CLAUDE_SUBSCRIPTION` and `ARGUS_LIVE_CODEX_DEPLOY` — STALE, and
this is the sharpest case.** `deploy-primitive.txt` (#55) says "Both halves
drive `deployWorker` itself: production router, production spawner, production
registry writer." That was true when written. Since then `deployWorker` grew a
**pre-trust step between the checkout and the row/spawn** (#96, `src/deploy/trust.ts`)
and its `Deployment` result grew four fields the #55 run could not have observed
— `workspace`, `surface`, `workspaceDegraded` and `trustDegraded`
(`src/deploy/deploy.ts:131-143`). The file also reasons about a
`workspace: "auto"` discovery path (line 79) which still exists but now resolves
through `openWorkerTab` rather than the deleted `createCmuxWorkspace`. So the
file's central claim — that it drove the whole primitive — is no longer true of
the primitive, and nothing in the file can tell a reader that.

**`ARGUS_LIVE_FULL_JOURNEY` — STALE.** `full-journey-e2e.txt` (#83) merged at
13:04, before all nine merges in the table. It is the most composed drive in the
repo — it deploys real agents through the deployment primitive and tails their
transcripts — so it is exposed to #94, #95, #89, #96 and #100 simultaneously.
Its resolution of 13.1's "1 of 2 replies" finding stands as a historical result;
its description of the path that produced it does not.

**`ARGUS_LIVE_HERMES` — STALE, and it was never whole.** `hermes-live.txt` (#47)
is from 2026-08-25 and records its `real` half as **`not-run`**: `~/.hermes/profiles`
did not exist, so only the scratch half ran. That half-gate has never been
closed. The file's own version line (`Hermes Agent v0.16.0`) is the thing that
makes a future break attributable, and it is worth checking against the installed
binary before trusting the §7 caveat it records.

**`ARGUS_LIVE_GRILL` — PARTLY STALE, in a specific and interesting way.**
`grill-live.txt` (#89) merged at 17:37, *before* #96 (19:22) and #97 (19:52).
Both of those tickets exist **because of what this drive found**: #89 drive 3 hit
Claude Code's first-run trust dialog and hung, which is the finding #96 was filed
to fix, and #96's own evidence file says so ("Found live by #89, drive 3"). So
`grill-live.txt` is an accurate record of a real run and a *stale* description of
grill behaviour: the dialog it hung on is now pre-trusted away, and #97 changed
how a grill mode's skill is dispatched (`resolveGrillSkill` → `resolveGrillDispatch`).
The finding is durable; the behaviour it describes is superseded by the fixes it
caused. **Do not re-run this to "refresh" it without recording that the failure
mode it documents is the one that was fixed** — that would delete the provenance
of #96.

**CURRENT — one line each, per #84's no-padding rule.**

- `ARGUS_LIVE_BATCH_SEARCH` — `batch-and-search.txt`, #92 at 19:52, second-newest
  merge on `main`. Current.
- `ARGUS_LIVE_CMUX` — `cmux-door.txt`, #90 at 18:07, and it is the model for the
  rest of this list: it opens by stating that the function the ticket named
  (`createCmuxWorkspace`) *no longer exists* and that two of the ticket's
  premises are stale as of #95. Evidence that says what moved under it is
  evidence that does not go stale silently. Current.
- `ARGUS_LIVE_LAUNCHD_SMOKE` — `launchd-live-smoke.txt`, #85 at 15:41. Predates
  the 16:43+ wave, but the wave touched deployment, cmux and skills; the launchd
  plist path (`src/supervisor/`) is untouched by all nine merges. Current.
- `ARGUS_LIVE_WATCHER_BRAINS` — `watcher-brains-correct.txt`, #91 at 18:07.
  Current.

---

## Transcriptions this ticket made

Three runs had no record outside a GitHub comment. Their durable substance is
now in `docs/acceptance/`, in three files that each carry this banner at the top:

> TRANSCRIBED FROM A GITHUB COMMENT — NOT A FRESH RUN.

| file | transcribes | gate | comment date |
| --- | --- | --- | --- |
| `honcho-isolation-live.txt` | #76 | `ARGUS_LIVE_HONCHO` | 2026-08-26T10:50:53Z |
| `watcher-brains-doubles.txt` | #77 | `ARGUS_LIVE_WATCHER_BRAINS` | 2026-08-26T11:19:28Z |
| `live-slots-drive.txt` | #78 | `ARGUS_LIVE_SLOTS` | 2026-08-26T11:26:33Z |

**A transcription is weaker evidence than a fresh run and each file says so.**
The numbers in them were measured by the ticket author on the date shown, on a
tree that is now ~15 merges behind. Nothing in them was re-measured by #101
except where a fresh run is recorded separately and cross-referenced by name.

**#77 is a partial exception worth stating precisely.** Its gate,
`ARGUS_LIVE_WATCHER_BRAINS`, *does* have a current file — `watcher-brains-correct.txt`
from #91. But #91 re-ran the gate to answer a different question (does the brain
give the *right* answer, not merely a parseable one; #91's own text says "The gate
has run before (#77) and it proved a real brain returned something the code could
PARSE"). #77's distinct result — which double was retired in each of eight slots,
and the 14-call distribution — appears in no file. So the gate is CURRENT and the
#77 run is still transcribed, because they are two different measurements.

---

## Correction to #84's gate recon

`docs/coverage/FEATURE-TEST-MATRIX.md` §1 is the direct ancestor of this file. It
was graded against `main` @ `ff82238` (2026-08-26 07:10) and is now itself out of
date in four ways. This is not a criticism of #84 — it is the same failure mode
#84 was filed to fix, recurring at the speed the repo moves, which is the
argument for this file being regenerable rather than hand-maintained.

| #84 said | now |
| --- | --- |
| "the **nine** opt-in gates" | **twelve** — `ARGUS_LIVE_GRILL` (#89), `ARGUS_LIVE_CMUX` (#90) and `ARGUS_LIVE_BATCH_SEARCH` (#92) all landed after `ff82238` |
| `ARGUS_LIVE_FULL_JOURNEY` — "**never run**, in flight as #83" | **run**; #83 merged at 13:04 with `full-journey-e2e.txt` |
| `ARGUS_LIVE_LAUNCHD_SMOKE` — "never run under its own gate", open as #85 | **run**; #85 merged at 15:41 with `launchd-live-smoke.txt` |
| "**three** gates' only evidence is a GitHub comment" (#76, #77, #78) | **two** at the time of this audit — #91 gave `ARGUS_LIVE_WATCHER_BRAINS` a file. All three runs are transcribed here regardless; see above. |
| "**No gate has been run on current `main`**" | still true in spirit and worth keeping: the newest gate evidence (#92, 19:52) is two merges behind `4a49096` |

---

## Half 2 — what was re-run, and what could not be

Recorded in `gate-rerun-101.txt`, alongside the explicit list of gates this
ticket could not run and what each would take. #99 holds the live watcher fleet
lease and was running a live Hermes drive throughout this audit, so every gate
needing the fleet, Hermes or a cmux surface was left alone by design rather than
by failure.

---

## Amendment — #107 acted on this grading (2026-08-27)

This section is appended, not woven in: #101's audit above is a record of what
was true at `4a49096` and stays that way. What follows is what the re-drives it
implied actually produced, at `5d405c0` (and `c4d9469` for the journey).

| file | was | now | run |
| --- | --- | --- | --- |
| `deploy-primitive.txt` | STALE | **REFRESHED, one half `not-run`** | codex half `run`; pre-trust step driven by a new committed runner |
| `live-agent-drive.txt` | STALE | **REFRESHED, drive UNRELIABLE** | gate `run`; 16/16 checks pass and the script exits 1 |
| `live-command-sweep.txt` | STALE | **REFRESHED** | re-run clean, exit 0 |
| `full-journey-e2e.txt` | STALE | **REFRESHED, unchanged** | 11 pass / 0 fail; 3 of 3 LIVE |
| `grill-live.txt` | PARTLY STALE | **header only, NOT re-run** | provenance of #96 preserved, as this map directs |
| `hermes-live.txt` | STALE | untouched | out of scope — #108 |

**Three corrections to the analysis above, found by doing the re-drives.**

1. **`ARGUS_LIVE_AGENTS`'s staleness reasoning was wrong about which code moved.**
   This map says its drive "deploys a Codex session through the deployment
   primitive" and is therefore exposed to #95, #96 and #89.
   `scripts/acceptance/live-agents.ts` does not call `deployWorker` at all — it
   spawns `codex exec` directly. Those three merges do not touch it. The file
   was stale for an unrelated and larger reason (below), and the deployment
   primitive's staleness is real but belongs only to `deploy-primitive.txt`.

2. **`live-command-sweep.txt` was stale in its command surface, not its
   deployment path.** The CLI grew six commands the old sweep never ran —
   `init`, `grill`, `dispatch`, `complete`, `signals`, `memory` — plus a
   `Flags:` section. Its `--help` capture listed six commands; it now lists
   twelve. Also worth stating: `scripts/acceptance/live-sweep.ts` reads **no
   gate at all** and spends no agent call, so mapping it to `ARGUS_LIVE_AGENTS`
   describes where the evidence belongs, not what switches it on.

3. **A gate this map records as `run` can no longer be run under the house
   rules, and nothing recorded that.** `ARGUS_LIVE_CLAUDE_SUBSCRIPTION`'s
   Claude half needs the real `HOME`; since #96 that half also reaches
   `trustDirectory`, which read-modify-renames Johan's live `~/.claude.json`
   (340 KB, 1276 project entries, rewritten continuously by his own sessions).
   #96's own evidence forbids that write in as many words. Redirecting only the
   trust write via `CLAUDE_CONFIG_DIR` does not work — measured: the binary
   reads credentials from the config dir too and reports "Not logged in". So
   the half is `not-run`, for a reason that is a property of the code rather
   than of the machine. **A fix ticket is warranted; #107 did not manufacture a
   pass.**

**And one new defect, found by re-driving rather than by reading.**
`RetroEye.persist` (`src/eyes/retro/retro.ts:966-978`) writes through a fixed
temp path, so two concurrent persists race and the loser's `rename` gets
ENOENT; `scripts/acceptance/live-agents.ts:433` calls `observeSession` without
`await`, which is what makes them concurrent and what turns the loss into an
unhandled rejection instead of a failed check. The drive therefore prints
"16/16 checks passed" and exits 1 — and on the first of two runs printed
nothing at all. `src/deploy/trust.ts` already carries the fix pattern
(pid + UUID in the temp name). Details in `live-agent-drive.txt` section 6.

**The thing this map asked for, now in each refreshed file:** a `HEAD` line.
The absence of a recorded commit is half of why these went stale invisibly —
dating them required reading ~25 merges. Each refreshed file names the commit
it is a record of, so the next audit is a `git log` away.
