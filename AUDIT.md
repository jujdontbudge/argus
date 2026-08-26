# Argus v1 specification audit

Audit target: branch `audit/spec-gaps`, commit `9f6282cf0d2a00e3e335b0ab242e0f1c88a9f8a9`.

This report treats source code and commands run in this worktree as evidence. Existing acceptance documents, map status, and closed-ticket claims are not used as proof.

Test commands were run with scratch `HOME`, `CODEX_HOME`, `HERMES_HOME`, and `CLAUDE_CONFIG_DIR`, with `codex`, `claude`, `hermes`, and real `gh` absent from `PATH`. That was required by the audit instruction not to spend live-agent calls or mutate real state. The resulting full-suite output was:

```text
bun test v1.3.12 (700fc117)

src/harness/live-agents.test.ts:
argus: live agent drives SKIPPED (claude, codex) — set ARGUS_LIVE_AGENTS=1 to run them; they burn a subscription

src/harness/subscription-drive.test.ts:
argus: subscription-mode Claude drive SKIPPED — set ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1 (or ARGUS_LIVE_AGENTS=1) to run it; it spends Johan's own subscription (no token)

src/tailing/hermes.live.test.ts:
argus: live Hermes verification — set ARGUS_LIVE_HERMES=1 to provision and drive a scratch profile
  scratch  SKIPPED  ARGUS_LIVE_HERMES is unset — the default gate never requires a Hermes install
  real     NOT RUN  no ~/.hermes/profiles/argus-*/state.db holds an assistant row — a real profile appears the first time Argus is deployed on a repo
  NO live Hermes half can run on this machine

 681 pass
 11 skip
 0 fail
 2187 expect() calls
Ran 692 tests across 100 files. [152.48s]
```

The four Codex watcher-brain integration tests are among the 11 skips because the safe test `PATH` intentionally made `codex` unavailable. An ordinary `bun test` on this machine would run them merely because `codex` is installed (`src/eyes/reviewer/live.test.ts:18-20`, `src/eyes/retro/live.test.ts:30,75,206`, `src/eyes/curator/live.test.ts:18,53`); that is itself a quiet-degradation finding below. TypeScript was **NOT RUN**: `bun x --no-install tsc --noEmit` failed before compilation with `TS2688: Cannot find type definition file for 'bun'`, and installing dependencies was explicitly forbidden.

## 1. SPEC §13: the ten fake-Johan scenarios

Ground truth:

- `bun test src/harness/all-scenarios.test.ts` really ran and returned `3 pass / 0 fail / 63 expect() calls` in 14.05 seconds. Its composed test is `src/harness/all-scenarios.test.ts:114-158`.
- `bun scripts/acceptance/scenario-evidence.ts` then ran the same composed registry and reported **10 structural scenarios, 126 assertions, 0 failing** in 11.4 seconds.
- None of those ten slots starts the real simulation-driver agent in `SimulationDriverRunner` (`src/harness/index.ts:311-333`). `runScenario` calls the registered handler directly (`src/harness/index.ts:849-899`). The real Codex and Claude checks are separate, narrow smoke tests (`src/harness/live-agents.test.ts:188-287`, `src/harness/subscription-drive.test.ts:66-232`) and were `gate-unset` / **SKIPPED**. The Hermes scratch check was also `gate-unset` / **SKIPPED**, and its read-only real-profile half was **not-run**.
- Therefore “PASSED” below is the harness's structural result, not a v1 acceptance verdict. A fixture brain/agent result is **PARTIAL**, not a live pass.

| # | Scenario | Did it actually run? | LIVE status | Honest verdict and evidence |
|---:|---|---|---|---|
| 1 | Autonomous batch, zero human input | **run / green**, STRUCTURAL: 9 assertions. Reviewer `src/eyes/reviewer/scenarios.ts:86-145`; Digest `src/eyes/digest/scenarios.ts:136-164`; Archiver `src/eyes/archiver/scenarios.ts:71-91`; Hermes/Codex transcript fixtures `src/tailing/hermes-scenarios.ts:44-60`, `src/tailing/codex-scenarios.ts:40-56`. | `gate-unset` / **SKIPPED** for generic real-agent smoke; no slot-level live drive. | **PARTIAL.** It synthesizes one registered session, never reads a frontier, dispatches a batch, or closes a ticket. SPEC §13.1's “tickets closed” assertion is absent from all nine assertions and from the contribution list at `src/harness/all-scenarios.test.ts:23-30`. |
| 2 | Fake-Johan takeover | **run / green**, STRUCTURAL: 40 assertions. Provenance `src/provenance/scenarios.ts:222-266`; Reviewer/Digest `src/eyes/reviewer/scenarios.ts:148-184`, `src/eyes/digest/scenarios.ts:167-195`; Retro scope drift `src/eyes/retro/scenarios.ts:442-581`; Honcho fixture `src/eyes/honcho/scenarios.ts:83-97`. | `gate-unset` / **SKIPPED**. | **PARTIAL.** Real provenance/output code runs, but the agent, reviewer/digest/retro brains, Honcho, and GitHub are fixtures. No real terminal takeover occurs. |
| 3 | Rogue session | **run / green**, STRUCTURAL: 24 assertions. `src/eyes/retro/scenarios.ts:259-395`; Codex fixture attribution `src/tailing/codex-scenarios.ts:59-86`. | `gate-unset` / **SKIPPED**. | **PARTIAL, with a production failure.** The scenario manually calls `eye.prime()` and `eye.scan()` (`src/eyes/retro/scenarios.ts:277-333`). Production calls `tick()`, which scans only after a Johan-authored record schedules the coalescer (`src/eyes/retro/retro.ts:413-441`), and its first scan merely primes and returns (`src/eyes/retro/retro.ts:449-457`). Git-only rogue work can therefore be missed forever. |
| 4 | Poisoning test | **run / green**, STRUCTURAL: 6 assertions. `src/provenance/scenarios.ts:269-311`; Hermes fixture `src/tailing/hermes-scenarios.ts:62-80`. | `gate-unset` / **SKIPPED**. | **PARTIAL.** The classifier and registry matcher are genuinely exercised, but no real Hermes send or agent transcript lands in this slot. The separate real-agent smokes were not run. |
| 5 | Fault injection: unlogged send | **run / green**, STRUCTURAL: 4 assertions. `src/provenance/scenarios.ts:314-355`. | `gate-unset` / **SKIPPED**. | **PARTIAL and operationally degraded.** The test calls an audit object “visible.” Production only prints it (`src/watch.ts:67-70`), while the supervisor discards every watcher's stderr/stdout (`src/supervisor/daemon.ts:13-20`). The unlogged send still classifies as Johan and can poison `USER.md`; no durable user-visible alarm is proven. |
| 6 | Watcher death | **run / green**, STRUCTURAL: 13 assertions. Real watcher commands are spawned/killed/restarted by an in-process supervisor at `src/harness/index.ts:422-548`; archiver replay is separately synthesized at `src/eyes/archiver/scenarios.ts:94-154`; unenrollment is `src/watch/scenarios.ts:8-53`. | Launchd smoke is `gate-unset` / **SKIPPED** (`src/supervisor/launchd-live.test.ts:8-10`); no live agent. | **PARTIAL.** This is strong structural process/replay coverage, but it does not run the actual launchd job or kill eyes during a real agent session. The launchd environment defect in §9 can leave “running” watcher processes unable to invoke brains or `gh`. |
| 7 | Signal paths | **run / green**, STRUCTURAL: 7 assertions. Digest fixture half `src/eyes/digest/scenarios.ts:198-259`; synthetic hook-handler half with fake cmux `src/events/scenarios.ts:15-96`. | Real Claude/Codex termination is `gate-unset` / **SKIPPED**. | **PARTIAL bordering on missing.** The “poll” half directly runs a fixture Digest brain and reads `INDEX.md`; there is no Hermes cron/read-screen poller in source. The push half directly calls handlers with crafted payloads and fake cmux, so no native hook fired. |
| 8 | Self-learning loop | **run / green**, STRUCTURAL: 9 assertions. Reviewer fixture brain `src/eyes/reviewer/scenarios.ts:187-240`; curator fixture brain/deterministic archive `src/eyes/curator/scenarios.ts:44-168`. | Watcher-brain live integrations **SKIPPED** in the safe run; no slot-level live agent. | **PARTIAL.** Real writers, archive moves, and policy gates run, but the learning and curator judgments are fixture outputs. Also, the “weekly” curator is only considered after a successful Reviewer evaluation (`src/eyes/reviewer/reviewer.ts:173-181,215-235`), not by a time-based scheduler. |
| 9 | Semantic isolation | **run / green**, STRUCTURAL: 9 assertions. `src/harness/index.ts:720-785`; `src/eyes/honcho/scenarios.ts:100-128`. | Local Honcho live ingest is not a slot-level semantic query; no live Deriver representation was queried. | **PARTIAL.** `FixtureHoncho.representation` is an in-memory peer-id filter, not Honcho's semantic representation. The test also gives each peer repo a separate scratch `HERMES_HOME`, hiding real shared-root profile collisions. |
| 10 | Blast-radius zero | **run / green**, STRUCTURAL: 5 assertions. `src/harness/index.ts:787-817`. | No live agent or running peer instance. | **PARTIAL.** It wipes one sandbox `.argus/` and compares another sandbox's files/registry bytes. It does not run the peer's eyes and prove that the peer instance “noticed” nothing, as SPEC §13.10 states. |

The suite is useful and genuinely green as a **structural component suite**. It is not the end-to-end fake-Johan harness described at `SPEC.md:434-547`, and its current “all ten scenarios pass” test name overstates the evidence.

## 2. SPEC §5-§10 requirement-by-requirement

### §5 — the five eyes and provenance

| Requirement | Status | Code evidence and discrepancy |
|---|---|---|
| Five separate, independently restarted processes per repo | **Implemented structurally** | The supervisor's canonical eye list is exactly five (`src/supervisor/runtime.ts:7-13`), and reconciliation spawns one child per repo/eye (`src/supervisor/runtime.ts:64-95`). Scenario 6 proves restarts structurally. Actual launchd viability is only partial; see §9. |
| One transcript-tailing stream across Claude Code, Codex, and Hermes | **Implemented, live proof partial** | `createRepoTranscriptSource` combines all three sources (`src/eyes/source.ts:93-109`). Claude/Codex have captured-real fixture and gated live coverage; the fresh test output said Hermes scratch **SKIPPED** and real assistant-row proof **NOT RUN**. |
| Provenance rule 1: Hermes records each deployment before start | **Missing production producer** | The schema/reader exists (`src/provenance/registry.ts:10-24,125-143`), but no production dispatcher or general deployment writer exists. Test drivers append the rows themselves. `notifyMissionControl` writes follow-up sends only, not deployments (`src/events/notify.ts:92-130`). |
| Provenance rule 2: every Hermes follow-up is recorded | **Partial** | The registry parser and matcher are solid (`src/provenance/registry.ts:36-45,148-171`; `src/matching/matcher.ts:85-175`). Mission-control event sends are fsync-appended before cmux (`src/events/notify.ts:53-61,110-129`). There is no generic production “Hermes send” command/adapter for grill and worker traffic because §7's dispatcher is absent. |
| Provenance rule 3: registered/unregistered/takeover/injected-context classification | **Implemented structurally** | Dispatch, registry send, synthetic preamble, unregistered Johan, takeover, and sticky touch logic are centralized at `src/provenance/classifier.ts:301-410`; candidate filtering is `src/matching/candidates.ts:78-155`. This is one of the strongest parts of the build. |
| Provenance rule 4: every eye uses the same mechanism | **Implemented** | Reviewer/Digest/Retro/Honcho use `ProvenanceFeed` (`src/watch.ts:84-175`); Archiver builds the same classifier from the registry (`src/watch.ts:151-166`). |
| §5.1 Reviewer: every turn seen, debounced/coalesced; USER only from Johan; MEMORY from all; skills written | **Implemented in code, production viability partial** | Pending turns are persisted before ingest returns and removed after success (`src/eyes/reviewer/reviewer.ts:109-180`). The USER gate resolves citations to provenance and rejects non-Johan sources (`src/eyes/reviewer/reviewer.ts:238-252`; `src/eyes/reviewer/outputs.ts:1-15`). The real brain command exists (`src/eyes/brain.ts:124-180`). Launchd cannot currently find this machine's `codex`, and watcher errors are hidden, so “implemented” is not “working when installed.” |
| §5.1 weekly curator, 30/90-day retirement and memory compaction | **Partial** | Policy, recoverable archive, and reports exist (`src/eyes/curator/curator.ts:395-447`; `src/eyes/curator/archive.ts:98-186`). The trigger is only called after a Reviewer batch succeeds (`src/eyes/reviewer/reviewer.ts:173-181`), so a quiet repo has no weekly pass. The brain is fixture-only in scenario 8. |
| §5.2 Archiver + FTS5 + `argus search` | **Implemented** | Messages and cursors commit atomically in SQLite/FTS5 (`src/eyes/archiver/archiver.ts:47-119,138-228`); read-only FTS search is `src/search/search.ts:59-109`; sandbox `argus search audit` returned exit 0. |
| §5.3 Honcho per-repo workspace and peer attribution | **Partial** | Durable at-least-once queueing and provenance-to-peer routing exist (`src/eyes/honcho/honcho.ts:85-132,200-292`). `argus up` writes a binding even when Honcho is unavailable. Real semantic representation isolation is unproven, self-hosted provisioning is absent, and workspace/profile identity uses only the repo basename (`src/up/bindings.ts:166-176,373-403`). |
| §5.4 running Digest + INDEX + status | **Implemented structurally; polling consumer missing** | Persistent pending state, immediate lifecycle status, atomic digest/INDEX writes, and narratives exist (`src/eyes/digest/digest.ts:145-320`; `src/eyes/digest/outputs.ts:179-239`). No Hermes process reads the index in production. |
| §5.5 Retro git/transcript/scope-drift detection and closed ticket filing | **Partial with a load-bearing production bug** | Detection/filing code is extensive (`src/eyes/retro/retro.ts:444-568,581-723,788-881`). Production scheduling is event-dependent and first-run priming discards work (`src/eyes/retro/retro.ts:413-457`). Tests and scenarios nearly always call `prime()`/`scan()` directly; there is no `tick()` coverage outside the scenario digest helper. |
| Write-policy matrix | **Implemented structurally** | Reviewer gates USER writes by provenance; facts/skills accept all provenance; Archiver stores all; Honcho maps peers; Digest carries touch state; Retro keeps Johan prompts. The absence of live slot-level drives leaves upstream transcript-shape drift unverified. |

### §6 — completion and blocking signals

| Requirement | Status | Code evidence and discrepancy |
|---|---|---|
| Native Claude Stop and Codex notify hooks write durable events | **Partial** | `argus up` installs both (`src/up/hooks.ts:43-61,99-152`; `src/up.ts:512-515`). Event files are exclusive-created and fsynced (`src/events/writer.ts:43-75`). But Claude Stop is incorrectly filtered through terminal-message regexes (`src/events/hooks.ts:37-53,99-133`): a genuine Stop whose last message lacks `DONE`, `gates green`, etc. is silently ignored. Scripts discard their handler result and always exit zero (`scripts/claude-stop.ts:1-5`, `scripts/codex-notify.ts:1-5`). No real native hook ran in this audit. |
| Push pings Hermes gateway/mission control | **Partial** | The event send is registry-first and cmux failure leaves a durable event (`src/events/notify.ts:92-130`). There is no dispatcher to register a Hermes mission workspace, so the normal outcome is degraded at `src/events/notify.ts:103-108`. There is no separate gateway API. |
| Digest maintains `running | blocked | done | dead` | **Implemented** | Mechanical lifecycle mapping is `src/eyes/digest/digest.ts:36-49,259-269`; terminal `dead` is protected in outputs. |
| Hermes cron polls INDEX + `cmux read-screen` as safety net | **Missing** | No production code references `cmux read-screen` or implements a Hermes poll loop. Scenario 7 merely reads `INDEX.md` inside its own test handler (`src/eyes/digest/scenarios.ts:223-258`). |

Additional quiet failure: malformed/wrong-repo event files are skipped without an audit and never marked seen (`src/watch.ts:42-64`). `eye-stuck` files are not `ArgusEvent` schema and no status/poller consumes them (`src/eyes/backpressure.ts:114-125`, `src/events/schema.ts:1-59`).

### §7 — work pipeline

| Requirement | Status | Code evidence and discrepancy |
|---|---|---|
| §7.1 grilling → spec → tickets → implement → review chain, GitHub frontier | **Missing as an Argus workflow** | No production source implements or invokes this chain. `argus up` writes static tracker docs/pointers (`src/up.ts:380-408`), but does not verify or run `setup-matt-pocock-skills`. |
| §7.2 grill flow: register, cmux workspace, Claude grill, attach notification, five eyes | **Missing** | No grill command, orchestration skill, cmux workspace creator, or deployment function exists in `src/`. Only transcript/provenance consumers exist. |
| §7.3.1 read open/unblocked/unclaimed frontier | **Missing** | The only GitHub reads are tracker setup and Retro candidate/scope reads (`src/up.ts:410-479`; `src/eyes/retro/gh.ts:121-201`), not a dispatch frontier. |
| §7.3.2 claim → worktree → cmux → fresh routed session → registry-first dispatch | **Missing** | Worktree creation exists only in the test harness (`src/harness/index.ts:281-295`). No production route/claim/session launcher exists. |
| §7.3.3 configurable concurrency cap 3 | **Missing** | `.argus/config.yaml` exposes only watcher-brain `max_concurrency: 2` (`src/up.ts:29-45`; `src/eyes/config.ts:41-58`), not worker dispatch concurrency. |
| §7.3.4 green review → merge → close → map update | **Missing** | No merge/verify/close/map dispatcher code exists. This is why scenario 1 cannot assert ticket closure. |
| §7.3.5 human attach/takeover safety | **Partial** | Provenance classification supports a takeover, but there is no production cmux session/workspace to attach to. |
| §7.4 Johan ad hoc sessions get identical coverage and Retro | **Partial** | Repo-scoped tailing sees unregistered sessions and classifies user prompts as Johan. Retro's scheduler/priming bug means ad hoc git work is not reliably ticketed. |
| §7.5 every implemented thing is a ticket | **Partial / not enforced end to end** | Retro can file correct closed tickets when explicitly scanned, but production does not periodically scan, and dispatched-work enforcement does not exist because the dispatcher does not exist. |

### §8 — memory and skills unification

| Requirement | Status | Code evidence and discrepancy |
|---|---|---|
| §8.1 canonical USER/MEMORY store shared by Reviewer, Claude, Hermes | **Mostly implemented** | Reviewer writes the canonical files; Claude memory is migrated then symlinked (`src/up.ts:245-276`); a per-repo Hermes profile's `memories` points to the same directory (`src/up/bindings.ts:296-370`). Valid sandbox output confirmed both symlinks. The files themselves are not seeded, so fresh `AGENTS.md` points at absent `USER.md`/`MEMORY.md` until a writer creates them. |
| §8.2 one skills store, three readers; Reviewer writes; curator retires | **Partial** | Claude gets `.claude/skills -> ../.argus/skills` (`src/up.ts:278-304`), Codex gets an `AGENTS.md` pointer, and Reviewer/curator writers exist. The required Hermes `skills.external_dirs` binding is never written: `ensureHermesProfile` only configures `memory` and disables native `curator` (`src/up/bindings.ts:315-340`). |
| §8.3 claude-mem curation/migration/uninstall | **Missing** | No source references its DB tables, migration, or uninstall. Only SPEC/docs mention claude-mem. |

### §9 — supervisor

| Requirement | Status | Code evidence and discrepancy |
|---|---|---|
| One launchd job, global repo list only, starts/restarts five watchers | **Implemented structurally** | Plist uses RunAtLoad/KeepAlive (`src/supervisor/plist.ts:18-46`); registry and restart loop are `src/supervisor/registry.ts:4-36`, `src/supervisor/runtime.ts:64-149`. Manual scratch supervisor execution showed all five eyes `running` and cleanly stopped them. |
| Works as installed on this machine | **Partial / likely inert once judgment is needed** | The plist sets only `ARGUS_REPOS_FILE` and status file, not `PATH` (`src/supervisor/plist.ts:33-39`). `/bin/launchctl getenv PATH` returned empty; this machine's `codex` is `/Users/johansardar/.local/bin/codex` and `gh` is `/opt/homebrew/bin/gh`. Reviewer/Digest/Retro spawn bare `codex`; Retro spawns bare `gh`. The process can stay alive while these operations fail forever. |
| Failures are observable | **Missing** | The daemon sends every watcher stdout/stderr to `ignore` (`src/supervisor/daemon.ts:13-20`). `argus status` reports “running” from PID liveness only (`src/supervisor/control.ts:155-183`) and surfaces only origin-kind refusal audits, not watcher errors, stuck brains, invalid events, or Honcho backlog. |

The actual launchd smoke was `gate-unset` / **SKIPPED** (`src/supervisor/launchd-live.test.ts:8-10`), as required by the audit's no-live-control safety rule.

### §10 — CLI

| Requirement | Status | Code evidence and discrepancy |
|---|---|---|
| `argus up` scaffold, ignore, migrate memory, adapters, tracker, supervisor, cmux hooks, start eyes | **Partial** | The core converger is `src/up.ts:491-544`. It scaffolds directories/config, memory and Claude adapters, AGENTS pointer, commits `.gitignore`, installs native push hooks, enrolls the repo, and creates local bindings. It degrades loudly when tracker/Honcho are unavailable. It does not configure Hermes skills, migrate claude-mem, verify/install the real Matt skill chain, verify cmux hooks, or implement orchestration. It literally prints `cmux hooks: pending #7 (soft check)` (`src/up.ts:542`). |
| `argus down` | **Implemented structurally** | `src/supervisor/commands.ts:9-20`; valid sandbox run returned exit 0 and emptied the registry. |
| `argus status` | **Implemented as process listing, partial as health** | `src/supervisor/commands.ts:23-29`; it cannot distinguish useful eyes from live processes retrying hidden failures. |
| `argus search` | **Implemented** | `src/cli.ts:80-122`; sandbox run against the created empty archive returned exit 0 and a clear no-match message. |
| `argus init` (explicitly requested by this audit) | **Missing** | The help/dispatcher exposes `up/down/status/watch/search/install`, not `init` (`src/cli.ts:7-18,124-173`). Valid sandbox output was `argus: unknown command 'init'`, exit 1. |

cmux on this machine is permanently 0.62.2. `cmux hooks --help` returned `Unknown command 'hooks'`; `cmux send`, `send-key`, and `read-screen` do exist. Therefore native push hooks can be the v1 route, but SPEC §3/§10's cmux-hook setup cannot be satisfied on this machine and should not remain an implied completion gate.

## 3. `argus init` / `argus up` end to end

The valid run used `/tmp/argus-audit-e2e.yMfJww/repo`, a new git repo with an allow-empty baseline commit and scratch homes/config. Launchd control was disabled so no job could inherit real user state. After `up`, I manually ran the real supervisor daemon under the same scratch environment, verified all five child commands, terminated only the process I spawned, and confirmed no sandbox watcher remained.

Actual CLI output:

```text
$ argus init
argus: unknown command 'init'
exit=1

$ argus up
TRACKER-LESS MODE: no GitHub remote; skipped GitHub labels and tracker checks
HONCHO DEGRADED: http://localhost:8000 unavailable (HONCHO_API_KEY and ~/.honcho/config.json apiKey are both missing); local bindings converged
Hermes profile: argus-repo
Push hooks: Claude Stop + Codex notify
cmux hooks: pending #7 (soft check)
Argus converged /private/tmp/argus-audit-e2e.yMfJww/repo
exit=0

$ argus up  # second run
TRACKER-LESS MODE: no GitHub remote; skipped GitHub labels and tracker checks
HONCHO DEGRADED: http://localhost:8000 unavailable (HONCHO_API_KEY and ~/.honcho/config.json apiKey are both missing); local bindings converged
Hermes profile: argus-repo
Push hooks: Claude Stop + Codex notify
cmux hooks: pending #7 (soft check)
Argus converged /private/tmp/argus-audit-e2e.yMfJww/repo
exit=0
```

It is idempotent in the sense that the second run succeeded and did not create another commit. What a real user gets after the first run:

```text
$ git status --short
?? .claude/
?? AGENTS.md
?? docs/

$ git log --oneline -2
c1e0b24 chore: ignore Argus state
acfbd09 sandbox baseline
```

So `up` silently creates a commit containing only `.gitignore`, while leaving the project integration files untracked. It creates native hook configs, Claude/Hermes memory symlinks, and the expected `.argus` directories, but a fresh `.argus/memory/` contains no `USER.md` or `MEMORY.md`.

Because launchd control was disabled for safety, `argus status` immediately after `up` correctly showed five stopped eyes. Running the production supervisor daemon manually under scratch state produced:

```text
REPO                                      EYE       STATE    PID
/private/tmp/argus-audit-e2e.yMfJww/repo  reviewer  running  75550
/private/tmp/argus-audit-e2e.yMfJww/repo  archiver  running  75551
/private/tmp/argus-audit-e2e.yMfJww/repo  honcho    running  75552
/private/tmp/argus-audit-e2e.yMfJww/repo  digest    running  75553
/private/tmp/argus-audit-e2e.yMfJww/repo  retro     running  75554
```

The supervisor exited 0 on SIGTERM and left no sandbox watcher processes. `argus down` returned 0 and `argus status` then showed only the header. `argus search audit` returned `No archived messages matched "audit".`, exit 0.

Audit safety note: an earlier discarded rehearsal created the temp repo but failed to change its shell cwd before invoking `up`; all environment/config roots were still scratch, but the target resolved to this audit worktree. I immediately inventoried artifacts by birth time, removed only the generated untracked `.argus`, `.claude`, `AGENTS.md`, and `docs/agents`, and verified `git status` was clean before the valid run above. No tracked file or real global config was changed.

## 4. PRIORITISED GAP LIST

Effort is an honest engineering guess: **S** ≤ 1 day, **M** 1–3 days, **L** 3–5 days. Each item is scoped as one ticket.

1. **P0 — Build the registry-first worker deployment primitive.** Why: Argus cannot deploy any work, so provenance rule 1, attachability, routing, and every §7 flow are test-only. Evidence: no production session/worktree/cmux launcher exists; worktree creation is only `src/harness/index.ts:281-295`. Deliver one primitive that creates a fresh worktree/workspace/session, records `sessions.jsonl` before spawn, routes Claude/Codex, and exposes a registry-first follow-up send. **Effort: L.**

2. **P0 — Build the GitHub frontier/claim/concurrency dispatcher.** Why: v1's AFK batch claim and cap-3 behavior does not exist. Evidence: no frontier reader; `.argus/config.yaml` has only brain concurrency (`src/eyes/config.ts:41-58`). Implement open/unblocked/unclaimed selection, assignment, cap, and recovery around the deployment primitive. **Effort: L.**

3. **P0 — Build the verify/merge/close/map completion loop.** Why: no ticket can finish autonomously, and scenario 1 omits “tickets closed.” Evidence: `src/harness/all-scenarios.test.ts:23-30` has no closure contribution; no production merge/close code exists. Consume completion signals, run gates/review, merge, close, and update the map. **Effort: L.**

4. **P0 — Implement the actual Hermes push consumer and slow-poll fallback.** Why: durable event files and Digest status currently have no orchestrator consumer; push degradation has no safety net. Evidence: no `read-screen`/cron source; scenario 7 directly reads files (`src/eyes/digest/scenarios.ts:223-258`). Implement event ingestion plus bounded INDEX/digest/read-screen polling and surface done/blocked/dead. **Effort: M.**

5. **P0 — Make the launchd job capable of finding brains/gh and report watcher health.** Why: installed eyes can show “running” while bare `codex` and `gh` are unreachable. Evidence: plist omits PATH (`src/supervisor/plist.ts:33-39`), launchd PATH is empty on this machine, daemon discards output (`src/supervisor/daemon.ts:13-20`). Write explicit executable paths/environment, capture per-eye last-success/error/backlog, and make `argus status` fail visibly on degraded eyes. **Effort: M.**

6. **P0 — Fix Retro startup and periodic scheduling.** Why: first work is primed away and git-only work never schedules a scan, so “every implemented thing is a ticket” is false. Evidence: only Johan records note the coalescer (`src/eyes/retro/retro.ts:413-425`); first scan primes and returns (`src/eyes/retro/retro.ts:449-457`); scenario 3 bypasses both. Prime on eye startup, scan on an independent cadence, persist observations immediately, and add production-`tick()` tests. **Effort: S–M.**

7. **P0 — Correct native hook semantics and prove real payloads locally.** Why: a real Claude Stop can be dropped unless its prose matches four completion regexes; scripts silently exit 0 on drift. Evidence: `src/events/hooks.ts:37-53,99-175`, `scripts/claude-stop.ts:1-5`. Treat valid Stop as end-of-session, persist/audit invalid payloads, keep Codex blocked/completion classification explicit, and add non-agent fixture captures from real hook payloads. **Effort: M.**

8. **P1 — Persist and surface provenance/event audits instead of printing into `/dev/null`.** Why: scenario 5's “visible” unlogged send is invisible under the production supervisor and can poison USER. Evidence: `src/watch.ts:67-70`; `src/supervisor/daemon.ts:13-20`; malformed events at `src/watch.ts:51-64`. Create a durable audit store/status surface with acknowledgement/deduplication. **Effort: M.**

9. **P1 — Build the registered cmux grill/HITL flow.** Why: §7.2 and v1's planning entry point do not exist even after worker deployment. Implement grill command/skill routing, registered Claude workspace, attach notification, and provenance-safe sends using the deployment primitive. cmux hooks must remain optional on permanent 0.62.2. **Effort: M.**

10. **P1 — Replace the “ten pass” claim with truthful structural/live acceptance gates.** Why: every slot is fixture-driven; scenario 1 omits closure, scenario 7 omits polling, scenario 9 does not query a real representation, scenario 10 has no peer instance. Evidence: `src/harness/index.ts:849-919`; fixture brains throughout scenario modules. Add explicit STRUCTURAL/LIVE verdicts, required assertion manifests matching SPEC text, and at least one opt-in full real-driver journey rather than narrow transcript smokes. **Effort: L.**

11. **P1 — Make repo identity collision-proof under one real HOME.** Why: two repositories with the same basename share `argus-<basename>` Honcho workspace/Hermes profile or the second setup refuses. Evidence: `src/up/bindings.ts:166-176,373-403`; scenario 9 hides this by giving peers different `HERMES_HOME`s. Derive a stable ID from canonical path/remote and migrate existing bindings. **Effort: M.**

12. **P1 — Complete the Hermes skills adapter.** Why: one-store/three-readers is false for Hermes. Evidence: Claude gets a symlink (`src/up.ts:278-304`), but Hermes profile config only gets memory limits and curator disabled (`src/up/bindings.ts:315-340`). Add/verify `skills.external_dirs` for `.argus/skills` and an end-to-end reader test. **Effort: S.**

13. **P1 — Implement the one-time claude-mem retirement migration.** Why: SPEC §8.3 is wholly absent, leaving a parallel memory system and migration debt. Evidence: no source references `observations`, `session_summaries`, or `user_prompts`. Build a read-only curation/import plan with explicit confirmation before uninstall. **Effort: M.**

14. **P2 — Finish `argus init/up` product semantics.** Why: `init` does not exist, `up` reports pending cmux hooks, writes pointers to absent memory files, substitutes static docs for Matt wiring verification, auto-commits only `.gitignore`, and leaves integration files untracked. Evidence: valid sandbox output plus `src/cli.ts:7-18`, `src/up.ts:380-408,491-544`. Define `init` versus `up`, seed canonical files, make commit behavior explicit, verify actual skill wiring, and report optional cmux capability honestly. **Effort: M.**

15. **P2 — Put every subscription/network integration behind an explicit gate.** Why: default `bun test` spends Codex calls whenever the binary exists and may mutate a live local Honcho instance whenever credentials/service exist. Evidence: `describe.skipIf(!codexAvailable)` in reviewer/retro/curator live tests and auto-probed Honcho at `src/eyes/honcho/live.test.ts:13-41,94-128`. Require named opt-in gates and print `gate-unset` versus `not-run` consistently. **Effort: S.**

## 5. What is genuinely FINE

- **The central provenance classifier and send matcher are solid structural work.** The rules are centralized, injected-context edge cases are handled conservatively, dispatch/sends are consumed exactly once, takeover is sticky, and suspicious states produce typed audits. The missing piece is the production producer/surface, not the classification core.
- **The Archiver/search path is complete and well designed.** SQLite transactions couple messages and cursors, replay keys prevent duplicates, FTS5 is real, and `argus search` works in the sandbox.
- **Watcher process mechanics are real.** Five actual commands can run, leases prevent duplicates, the in-process supervisor restarts dead children, status snapshots are atomic, and sandbox teardown left no child behind. The launchd environment/observability layer is what prevents calling this production-ready.
- **Memory/skill writers have good invariants.** USER writes are provenance-gated outside the model, MEMORY uses a repairable index/per-fact format, skill/fact retirement is recoverable rather than deletion, and pending Reviewer/Digest batches survive crashes.
- **Sandbox safety is substantive.** `SandboxScope`, scratch homes, scoped watcher adoption, and destructive-operation guards are not paper promises. The structural scenarios really do create, mutate, and tear down isolated repositories.
- **`argus up`'s local scaffolding core is mostly idempotent.** The second valid run exited 0 without another commit; Claude/Codex native hook configs and memory/skills symlinks were created where expected; tracker-less and Honcho-degraded modes were loud rather than falsely green.

Bottom line: Argus has a substantial watcher toolkit and a good structural test corpus. It is **not v1 done** as the orchestration product in SPEC: the dispatcher, completion loop, poll fallback, reliable Retro scheduling, and installed watcher viability are still absent or unproven.
