# Feature × evidence matrix

Ticket #84, sub-issue of map #81. Graded 2026-08-26 against `main` @ `ff82238`.
Companion to [FEATURE-INVENTORY.md](FEATURE-INVENTORY.md); `Fnn` refers to its rows.

## How to read the status column

| Status | Means |
| --- | --- |
| **LIVE** | Exercised against the real dependency, with recorded evidence. |
| **STRUCTURAL** | A real production code path exercised over substituted components. |
| **ASSERTED** | A test names the behaviour but nothing about it can fail — a constant compared to a constant, or an input handed to a real dependency whose answer is never checked. |
| **NONE** | No test exercises it at all. |
| **NOT IMPL.** | No code path exists. Not a coverage gap — an implementation gap. |

`bun test`'s default census reads **10 of 10 STRUCTURAL, 0 of 10 LIVE, 36 requirements
= 5 covered / 29 partial / 2 uncovered**. That is correct by design and is not a gap: a
default `bun test` must never spawn real agents. LIVE is what the nine opt-in gates buy.

---

## 1. Correction to map #81's gate recon

#81 records seven gates as never run. Verified against the committed evidence, only
**two** have never run:

| Gate | #81 said | Actually | Evidence |
| --- | --- | --- | --- |
| `ARGUS_LIVE_AGENTS` | never run | **RUN** (#36) | `docs/acceptance/live-agent-drive.txt` — real Codex sol-high session |
| `ARGUS_LIVE_CLAUDE_SUBSCRIPTION` | never run | **RUN** (#55) | `docs/acceptance/deploy-primitive.txt` — 2 pass, 12 expects, 45.10s |
| `ARGUS_LIVE_CODEX_DEPLOY` | never run | **RUN** (#55) | same file, same command line |
| `ARGUS_LIVE_HERMES` | never run | **RUN** (#47), real-profile half NOT RUN | `docs/acceptance/hermes-live.txt` — `~/.hermes/profiles` does not exist |
| `ARGUS_LIVE_WATCHER_BRAINS` | run | run (#77) | issue comment only — no file under `docs/acceptance/` |
| `ARGUS_LIVE_SLOTS` | run | run (#78) | issue comment only |
| `ARGUS_LIVE_HONCHO` | run | run (#76) | issue comment only |
| `ARGUS_LIVE_FULL_JOURNEY` | never run | **never run** | in flight as #83 |
| `ARGUS_LIVE_LAUNCHD_SMOKE` | never run | **never run under its own gate** | open as #85. #86 records a real `dev.argus.supervisor` LaunchAgent registered live on 2026-08-26 by the #82/#85 runs — so launchd bring-up has happened on this machine, incidentally and with no committed evidence |

Two second-order facts fall out of this table. **No gate has been run on current
`main`** — the newest acceptance file is #73's, and `ff82238` is three merges later.
And three gates' only evidence is a GitHub comment, which does not survive the repo
being cloned somewhere else.

---

## 2. Evidence status, all 113 features

### A. Design principles

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F1 | Per-project, nothing global | LIVE | slot 10 + `init-up-e2e.txt` (#73) |
| F2 | One store, many readers | STRUCTURAL | `resolveGrillSkill` precedence tests; #73's read-back through `.claude/skills` |
| F3 | Everything is a ticket | STRUCTURAL | slot 3 |
| F4 | Fork with a tether | **ASSERTED** | `skills.test.ts:42-44` compares `GRILL_MODES.spec.skill` to the literal it was built from |
| F5 | Provenance-aware, always-on | STRUCTURAL | slots 1–5 |
| F6 | Every session is attachable | **NONE** | `13.2.driver-attaches` has an empty assertion list — UNCOVERED in the manifest. Known: #18 |
| F7 | No Anthropic API; subscription Claude | LIVE | `deploy-primitive.txt` (#55) |
| F8 | No metered OpenAI API | LIVE | #77 real brains on `codex exec` |
| F9 | Unsupported model slug refused | STRUCTURAL | `src/eyes/config.ts:173-178` + unit tests |
| F10 | Bun + TypeScript, zero deps | LIVE | it is the build |

### B. Agents and routing

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F11 | Three agents, fixed jobs | STRUCTURAL | `deployWorker` route tests |
| F12 | **Routing by ticket label** | **NOT IMPL.** | `src/dispatch/dispatch.ts:134` — `const agent = options.agent ?? "claude"`. `FrontierTicket.labels` is read from `gh` (`frontier.ts:101`) and then never consulted. Every dispatched ticket goes to Claude. → **#88** |
| F13 | Per-ticket `agent:` override | **NOT IMPL.** | same line; no `agent:codex` handling anywhere |
| F14 | Three transcript sources tailed uniformly | LIVE (2 of 3) | real Claude (#55) and real Codex (#36) transcripts; the Hermes third has never been read from a real profile |
| F15 | Worker model is a config knob | **NOT IMPL.** | `src/eyes/config.ts` parses brain models and `dispatch.max_concurrency` only. The worker model is hardcoded at `routes.ts:79`; `dispatch.ts:93`'s docblock says the config is "the normal source" and no such source exists |

### C. cmux worker surface

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F16 | One workspace per deployed session | STRUCTURAL | `workspace.ts` tests over a fake cmux runner; `cmux` is a manifest `Double` in every slot |
| F17 | **Mission control** (`set-status`, `set-progress`, `markdown open`) | **NOT IMPL.** | production invokes exactly five cmux subcommands: `new-workspace`, `list-workspaces`, `read-screen`, `send-key`, `notify`. The other three appear nowhere |
| F18 | `read-screen` on workers | STRUCTURAL | `events/consumer.ts:154` over a fake runner → **#90** |
| F19 | Registry-logged send, first | STRUCTURAL | slot 5 (the unlogged-send fault injection) → **#90** |
| F20 | Resume hooks optional | LIVE | #7 |
| F21 | **Workers as tabs that fully close** | **NOT IMPL.** | `new-workspace` is the only creation path and **nothing in the tree ever closes a workspace**. Every dispatched ticket leaks one. Also a shape conflict: `--cwd` creates a workspace, the directive asks for a tab in the existing one |

### D. Layout and adapters

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F22–F27 | `.argus/` scaffold, memory move + symlink, skills symlink, Hermes `external_dirs`, AGENTS.md block, committed gitignore line | LIVE | `init-up-e2e.txt` (#73) — real sandbox, real `argus init` / `argus up`, wiring verified by read-back |

### E. Provenance

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F28–F35 | Registry as sole truth; deployment-before-start; sends logged; the four classification rules; envelope/`origin.kind` policy; one mechanism | STRUCTURAL | slots 1–5, 19 requirement ids. The registry-before-start rule additionally proven LIVE for both agents by #55 |
| F36 | Linear envelope scan | STRUCTURAL | #80 regression test |

### F. Reviewer

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F37 | Every turn seen | STRUCTURAL | reviewer debounce tests |
| F38 | `codex exec` brain on the subscription | LIVE | #77 |
| F39 | `USER.md` only from Johan | STRUCTURAL | `13.1.user-md`, whose own `liveShortfall` records that a *fixture* brain is what declined to write |
| F40–F41 | `MEMORY.md` from any provenance; procedures → skills | STRUCTURAL | slot 1, slot 8 |
| F42 | Environment observations are facts (#71) | STRUCTURAL, live-unasserted | fixture-brain tests pass. `reviewer/live.test.ts` runs the real brain and asserts only `expect(["user-preference","project-fact"]).toContain(finding.kind)` — either answer passes → **#91** |
| F43 | Two asks, never one (#69) | STRUCTURAL | `reviewer.test.ts:385,428,462`, including "a procedure returned by the extraction pass never reaches the skills surface". Genuinely covered — **no ticket** |
| F44 | Curator prunes/archives skills | LIVE | `curator/live.test.ts` asserts the busy umbrella is neither pruned nor consolidated |
| F45 | **Curator compacts the memory files** | **ASSERTED** | `curator/live.test.ts:64-67` plants two near-duplicate facts into the real brain's prompt and asserts **nothing** about what comes back. The unit test at `curator.test.ts:313` hands the verdict in. → **#91** |
| F46 | Create/update/delete are one loop | STRUCTURAL | curator unit tests |
| F47 | luna@low settled on all four eyes | LIVE | #54 benchmark, `docs/research/watcher-brain-tiers.md` |

### G. Archiver

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F48 | Every message archived, no filtering | STRUCTURAL | slots 1 and 6 — one synthesized fixture session, asserted by reading the DB directly |
| F49 | `argus search` | STRUCTURAL | `src/search/search.test.ts` over a fixture DB. Never run over an archive that several real agents wrote → **#92** |

### H. Honcho

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F50 | Per-repo workspace | LIVE | #76 against localhost:8000 |
| F51 | Provenance decides peer attribution | STRUCTURAL | `13.9.representation-johan-only` |
| F52 | Self-hosted first | LIVE | #76 |

### I. Digest

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F53–F55 | Per-session digest, frontmatter, INDEX zoom path | STRUCTURAL | `13.1.digests-index` |
| F56 | `status:` doubles as the slow-poll signal | STRUCTURAL, **no live brain at all** | slot 7. `src/eyes/digest/` is the only judgment eye with **no `live.test.ts`** — three of four eyes have one → **#91** |

### J. Retro

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F57–F58 | Git and transcript signals | STRUCTURAL | slot 3 |
| F59 | Scope-drift signal (#38) | LIVE | `retro/live.test.ts:254-265` asserts drift true *and* false against the real brain — the strongest live assertion in the tree |
| F60–F61 | Closed retro sub-issue, correct parent, no approval queue | STRUCTURAL | `13.3.retro-closed-subissue`, `13.3.correct-parent` over `fake-gh.ts` |
| F62 | Write-policy matrix | STRUCTURAL | slots 1, 2, 4 |

### K. Signals

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F63 | Native Claude `Stop` + Codex `notify` push | LIVE | #7 proved both end to end (SPEC.md:144) |
| F64 | `argus up` installs both | LIVE | #73 |
| F65 | Event durable, ping best-effort, degrades loudly | STRUCTURAL | slot 7 |
| F66 | **Never type into an unresolved handle (#7)** | STRUCTURAL | `notify.ts:118` resolves via `list-workspaces` first — but only ever against a **fake** runner. The hazard being defended against is a real cmux 0.62.2 behaviour (exits 0, types into the focused workspace) → **#90** |
| F67–F69 | 5-minute poll, shared cursor, silent empty sweeps | STRUCTURAL | slot 7, `13.7.slow-poll-within-interval` |

### L. Pipeline

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F70 | The pocock-plus chain | ASSERTED | see F4 |
| F71 | GitHub Issues tracker, sub-issues, blocking edges | STRUCTURAL + LIVE | `fake-gh.ts` for the frontier; #73 created real labels. #56's `blocked_by` path is a known gap (#18) |
| F72 | Grill flow | STRUCTURAL | `grill.test.ts`, `launch.test.ts`. **No harness scenario drives `argus grill`** → **#89** |
| F73 | All five watchers cover a grill live | **NONE** | §14 bullet 1 has never been run → **#89** |
| F74 | The skill **id** is part of the route | **ASSERTED** | see F4. Nothing checks the id resolves on this machine → folded into **#89** |
| F75–F76 | Frontier read; claim → worktree → workspace → fresh session → register → dispatch | STRUCTURAL | `dispatch.test.ts` |
| F77 | Cap 3, enforced at production's door | LIVE (mechanics) / **NONE** (under load) | #78 ran `ARGUS_LIVE_SLOTS`. Three *real* sessions have never been in flight at once → **#92** |
| F78 | On green: merge, close, update the map | STRUCTURAL | `complete.test.ts`; scenario 1 now provisions a locked TypeScript project and runs `DEFAULT_GATES` in the production-created worktree (#87) |
| F79 | Johan can attach to any ticket workspace | **NONE** | same hole as F6 |
| F80–F81 | Ad hoc coverage; planning exempt | STRUCTURAL | slot 3 |
| F82 | **A gate is only a gate if it can refuse** | STRUCTURAL | `gates-worktree.test.ts` creates a real worktree through the production primitive, passes both defaults, then makes typecheck refuse a deliberate error (#87) |

### M. Memory and skills

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F83 | Per-repo memory pair | LIVE | #73 |
| F84 | Hermes flush bound to the repo pair | STRUCTURAL | `bindings.ts:263-283` — `profileOwner` proves ownership by requiring `<profile>/memories` to be a **symlink resolving to `<repo>/.argus/memory`**. The flush destination follows from the symlink; there is no second behaviour to test. **No ticket** |
| F85 | Canonical `.argus/skills/`, three readers | LIVE | #73 read a canonical skill back through `.claude/skills` |
| F86 | Reviewer writes, curator retires | STRUCTURAL | slot 8 |
| F87 | claude-mem retirement | n/a | one-time manual migration — see §5 |

### N. Supervisor

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F88 | **launchd keeps five watchers alive, restarting on crash** | STRUCTURAL (start) / **NONE** (restart) | slot 6 runs over a `supervisor` **double**. `launchd-live.test.ts` is 55 lines that bootstrap a scratch job, `print` it, and assert it ran once — it never kills anything, and its gate has never been run → folded into **#85** |

### O. CLI

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F89–F96 | `init` scope and self-verification, `up` convergence, optional cmux hooks, no-default-commit, `down`/`status`, `signals` | LIVE | `init-up-e2e.txt` (#73) drove the real product path in a real sandbox with scratch everything |
| F97 | `argus search` | STRUCTURAL | see F49 → **#92** |

### P. Test doctrine

| # | Feature | Status | Covered by |
| --- | --- | --- | --- |
| F98 | The fake-Johan driver actually drives | **NONE** live | `SimulationDriverRunner` is called only from `full-journey.ts`, whose gate has never been run. In flight as **#83** — no ticket |
| F99 | Verdicts, not bare passes | STRUCTURAL | the census itself |
| F100 | LIVE is evidence-gated | LIVE | #78 ran `ARGUS_LIVE_SLOTS`; `effectiveDoubles` returns doubles untouched on empty evidence |
| F101 | Test agents in isolation | LIVE | #36, #73 |
| F102 | Subscription mode is the default live path | LIVE | #55 |
| F103–F106 | Hermetic mode stricter, refusal ordering, tokenless is never blocking, mode named on the banner, `SandboxScope` | STRUCTURAL | `subscription-gate` and `SandboxScope` unit tests |
| F107 | Deployed Claude runs Opus 5 | LIVE (model) / **NOT IMPL.** (effort) | `routes.ts:79` + #55. No effort flag exists anywhere; SPEC.md:101's table still says "Fable" |

### Q. §14 — "It's working if"

| # | Acceptance bullet | Status | Covered by |
| --- | --- | --- | --- |
| F108 | §14.1 grill → all five stores, zero manual capture | **NONE** | → **#89** |
| F109 | §14.2 ten tickets, three at a time, fresh attachable sessions, `USER.md` gains nothing | **NONE** | slot 1 is **one synthesized fixture session**, not three live ones; and its merge/close leg cannot pass (F82) → **#87**, **#92** |
| F110 | §14.3 hijack is visible | STRUCTURAL | slot 2, minus `13.2.driver-attaches` |
| F111 | §14.4 `argus search` across agents and sessions | **NONE** | → **#92** |
| F112 | §14.5 blast radius zero | STRUCTURAL | slot 10 |

---

## 3. What the ten scenarios do not cover

The ten §13 scenarios are a provenance suite. Read as a set, they cover the
classification of messages and the writes that follow from it, thoroughly. Five things
they were never shaped to see:

1. **Routing.** No scenario asserts which agent a ticket goes to. The dispatcher
   hardcodes Claude and drops the labels it read. (#88)
2. **The grill half of the pipeline.** Every scenario is an AFK scenario. §14's first
   acceptance bullet — the HITL one, the one with Johan in it — has no scenario. (#89)
3. **The cmux door.** `cmux` is a `Double` in every slot that names it. The one
   behaviour that made #7 a ticket is a property of a real cmux binary. (#90)
4. **Judgment, as opposed to schema-conformance.** The live-brain gate proves the
   brain returns parseable JSON. Where #54 measured it answering *wrongly*, the live
   tests either look away (curator's memory half) or accept both answers
   (reviewer's fact kind). The digest has no live brain test at all. (#91)
5. **Concurrency and scale.** Every scenario runs one session. §14 bullet 2 asks for
   three at once, and the cap that governs them has never had three real sessions to
   hold back. (#92)

Plus one that belongs to the supervisor rather than the scenarios: **restart-on-crash
runs over a double, and the launchd gate has never been run** (#85).

---

## 4. The matrix, and the tickets cut

| Ticket | Feature rows | Kind | Cost |
| --- | --- | --- | --- |
| **#87** | F82, F78, F109 | Confirmed defect — default gates cannot run in a fresh worktree | free |
| **#88** | F12, F13, F11 | Confirmed defect — labels read, then dropped | free |
| **#89** | F108, F72, F73, F74, F4, F70 | §14.1 grill journey, live | 1 subscription session |
| **#90** | F16, F18, F19, F66, F17, F21 | The cmux door against a real cmux | free (no model calls) |
| **#91** | F42, F45, F56, F47 | Live-brain tests assert judgment, not parse-ability | 3–4 `codex exec` calls, $0 |
| **#92** | F109, F77, F49, F97, F111, F76 | §14.2 three at a time + §14.4 search across agents | 3 subscription sessions |

**Six tickets, from 113 features.** A seventh was cut and withdrawn: #93 (supervisor
restart-on-crash) duplicated **#85**, which was filed after this map's recon snapshot
and already owns the live launchd bring-up. Its one non-overlapping assertion — kill an
eye, assert a *different* PID returns and the other four are untouched — was folded into
#85 as a scope addition and #93 closed. Two tickets bootstrapping two scratch launchd
jobs is the duplication this exercise exists to prevent.

### Checked and deliberately NOT ticketed

The list that matters as much as the tickets.

| Feature | Why no ticket |
| --- | --- |
| F43 — two asks, never one (#69) | `reviewer.test.ts:385,428,462` already asserts the split *and* that an extraction-pass procedure never reaches the skills surface. Genuinely covered. |
| F84 — Hermes memory binding | `profileOwner` proves ownership by symlink identity. A flush test would assert filesystem semantics, not Argus behaviour. |
| F59 — scope drift | `retro/live.test.ts` already asserts drift both true and false against the real brain. Nothing to add. |
| F98 — the journey driver | In flight as **#83**. Filing it again would be the padding this ticket exists to avoid. |
| Hermes drives a batch, skill graded | In flight as **#82**. |
| F88 — launchd bring-up, PATH under an empty environment, failed watchers visible in `argus status` | Open as **#85**, filed after this map's recon snapshot. The restart-on-crash assertion it lacked is folded in there. |
| The watcher leak and restart storm | Open as **#86** — measured live on 2026-08-26 (~200 MB/min per eye, a keepalive agent that outlived its test worker). A coverage ticket would restate a defect that already has evidence. |
| F6 / F79 — attachability (`13.2.driver-attaches`) | Already an open, named gap in #18's final report. Re-filing a listed gap adds a number, not a test. |
| `13.9.query-workspace`, `13.9.repo-isolation`, `13.7.native-hook`, §13.1's 1-of-2 live shortfall, #56's `blocked_by` path, the hardcoded subscription allowlist, cmux 0.62.2 | All already listed in #18. Same reason. |
| "Make the census LIVE" | Not a gap. 10/10 STRUCTURAL is the correct default reading. |
| F12/F13/F15/F17/F21/F107-effort — the six NOT IMPL. findings | These need *implementation* tickets, which is #81's call, not simulations. #88 is the one exception: label routing has an assertion that is cheap, hermetic and fails today, so the test is worth having whichever way the implementation goes. The other five are reported and left to the map. |
| F87 — claude-mem retirement | A one-time manual migration. There is nothing left to run. |

---

## 5. What cannot be simulated

Known gaps, stated so they stop being silent ones.

**Needs Johan.**

1. **A real grill.** #89 simulates the *machinery* with a scripted stand-in, but §14
   bullet 1's actual claim is that Johan's own answers become USER.md facts. Only
   Johan typing can produce a genuinely Johan-authored message; a fake-Johan send is
   registry-logged by construction, which is the opposite of what the bullet tests.
2. **Attachability (F6, F79).** `13.2.driver-attaches` is UNCOVERED because attaching
   is a person opening a terminal. The harness can write a message that *classifies*
   as a takeover; it cannot prove a human could have.
3. **`~/.hermes/profiles` does not exist on this machine.** #47's real half is not
   skipped for hermeticity — there is nothing to read. Until a real Hermes profile
   exists, the third transcript source (F14) is proven only against fixtures.
4. **Is the retro ticket the *right* ticket?** Whether a filed `Retro:` body is a fair
   account of what happened is a judgment only Johan can make. The harness can assert
   it was filed, closed, parented and non-empty — and does.

**Needs real elapsed time.**

5. **Curator staleness (30 days) and archival (90 days).** Every test injects
   `idleDays`. Nothing has proven the clock arithmetic against a store that actually
   aged; a sign error would pass every test in the tree.
6. **The weekly curator gate (168h).** Same shape.
7. **Restart on *login* (F88).** #85 can kill a process and watch launchd restart it.
   It cannot log out and back in, and `RunAtLoad` is a different code path from
   `KeepAlive`.
8. **Cron drift.** The 5-minute Hermes poll (F67) is asserted by installing the cron
   line. Whether it actually fires every five minutes for a week is unobservable in a
   test run.

**Needs a second machine or a second repo's real history.**

9. **F112 blast-radius zero at scale.** Slot 10 wipes a sandbox `.argus/` and checks
   one other sandbox. "No *other repo's* instance noticed" across the machine's real
   Argus-enabled repos cannot be asserted without touching them, which the house rules
   forbid.
