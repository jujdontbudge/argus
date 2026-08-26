# Feature inventory — everything Argus was ever asked for

Ticket #84, sub-issue of map #81. Compiled 2026-08-26 against `main` @ `ff82238`.

**What this is.** Every feature and promise this system was asked for, enumerated
from the sources where the asks actually live, each with the line that promised it.
This file is the input to [FEATURE-TEST-MATRIX.md](FEATURE-TEST-MATRIX.md), which
grades each entry against the evidence that exists today. It is deliberately
larger than the §13 scenario suite: the ten scenarios are the acceptance suite we
happen to have, not the set of things that were asked for.

**Sources read end to end.** `SPEC.md` (all 731 lines, every numbered principle,
§14 in full); `docs/adr/0001-implementation-stack-bun-typescript.md`;
`docs/adr/0002-watcher-brain-defaults.md`; the resolution comments of all closed
tickets (`gh issue list -R JohanSardar/argus --state closed --limit 200`, closing
comments read in full — that is where the decisions actually live); `src/harness/`
(`verdicts.ts`, `live-slots.ts`, `full-journey.ts`, `honcho-isolation.ts`); the
seven committed evidence files under `docs/acceptance/`.

**One source was unavailable.** `$SP/loop-state.md` does not exist on this machine
(`SP` is unset; no such file is findable). The standing Johan directives are
therefore taken from #84's own enumeration of them plus their SPEC anchors, and
§S records them explicitly rather than silently dropping them.

**Citation form.** `SPEC.md:N` is a line in the spec at `ff82238`. `#N` is a GitHub
issue whose closing comment carries the decision. `path:N` is source.

---

## A. Design principles (SPEC §1)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F1 | Everything per-project; `.argus/` is repo-local; nothing global except the supervisor | SPEC.md:24 |
| F2 | One store, many readers — no parallel memory systems | SPEC.md:29 |
| F3 | Every implemented thing is a ticket | SPEC.md:33 |
| F4 | Fork with a tether: the pocock-plus chain runs from Johan's fork, not a re-implementation | SPEC.md:35 |
| F5 | Provenance-aware, always-on watchers (not opt-in per session) | SPEC.md:43 |
| F6 | Every session is attachable — Johan can take over anything, any time | SPEC.md:46 |
| F7 | Never require Anthropic API access: Claude runs on the subscription, no token, no API key | SPEC.md:49 |
| F8 | The same rule binds OpenAI: no metered API; brains run `codex exec` on the ChatGPT subscription | SPEC.md:71 |
| F9 | An unsupported model slug is refused rather than silently defaulted (the one config exception) | `src/eyes/config.ts:173-178`, SPEC.md:71 |
| F10 | Implementation stack is Bun + TypeScript, zero runtime dependencies, run-from-checkout install | `docs/adr/0001-implementation-stack-bun-typescript.md` |

## B. The three agents and routing (SPEC §2)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F11 | Three agents with fixed jobs: Hermes orchestrates and never implements; Claude plans; Codex implements | SPEC.md:100-102 |
| F12 | Routing is by ticket label: `grilling`/`spec`/`review`/`diagnosis` → Claude, default → Codex | SPEC.md:109-110 |
| F13 | Per-ticket override with an explicit `agent:claude-code` / `agent:codex` label | SPEC.md:111-112 |
| F14 | Three transcript sources tailed uniformly into one event stream (Claude `~/.claude/projects`, Codex rollouts, Hermes sessions) | SPEC.md:115-119 |
| F15 | Worker model choices are config knobs in `.argus/config.yaml`, not commitments | SPEC.md:104-105 |

## C. Worker surface: cmux (SPEC §3)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F16 | One cmux workspace per deployed session, `--cwd` on the repo or worktree, named `<repo>/<ticket-or-purpose>` | SPEC.md:129-131 |
| F17 | Mission control: `set-status`, `set-progress`, `notify`, `markdown open` beside workers | SPEC.md:132-135 |
| F18 | Hermes reads any worker's terminal with `cmux read-screen` (slow path) and its digest (fast path) | SPEC.md:136-137 |
| F19 | Every Hermes-authored `send`/`send-key` is logged to the registry **first** — non-negotiable | SPEC.md:138-140 |
| F20 | cmux resume hooks are optional; setup never blocks on them (#7) | SPEC.md:141-144 |
| F21 | A deployed worker's workspace is a **tab in the existing workspace that fully closes** when the work ends | Standing Johan directive (#84 body); tension with F16 noted in §S |

## D. Per-repo layout and adapters (SPEC §4)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F22 | `.argus/` scaffolded with config, registry, memory, skills, sessions, archive.db, events, honcho.yaml | SPEC.md:157-173 |
| F23 | Claude Code's built-in memory dir is **moved** into `.argus/memory/` and replaced by a symlink | SPEC.md:177-180 |
| F24 | `.claude/skills/` entries symlinked from `.argus/skills/` | SPEC.md:181 |
| F25 | Hermes `skills.external_dirs` gains the repo's `.argus/skills` path | SPEC.md:182 |
| F26 | `AGENTS.md` gains a pointer block: memory files, skills dir, `argus search` usage | SPEC.md:183 |
| F27 | `.argus/` is a **committed** `.gitignore` line, so every clone ignores it | SPEC.md:185-186 |

## E. Provenance model (SPEC §5)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F28 | The registry is the single source of provenance truth | SPEC.md:199 |
| F29 | Every deployment is recorded **before** the session starts (id, agent, ticket, full dispatch prompt) | SPEC.md:201-202 |
| F30 | Every follow-up message Hermes types is recorded in `sends.jsonl` | SPEC.md:203 |
| F31 | Unregistered session → user messages are Johan-authored | SPEC.md:205-206 |
| F32 | Registered session → dispatch + logged sends are Hermes; any other user-side message is a takeover | SPEC.md:207-209 |
| F33 | Not every user-role record is a prompt: an opening-run context envelope classifies **system**, and both directions are audited loudly | SPEC.md:210-218 |
| F34 | How a prompt arrived is not provenance: `origin.kind` ≠ human / `promptSource: system` is not a prompt; unknown kinds refuse, unknown source names are heard | SPEC.md:219-232 |
| F35 | Every watcher classifies through this one mechanism — no heuristics elsewhere | SPEC.md:233 |
| F36 | Synthetic envelopes are matched by linear scan, not by index arithmetic (#80) | #80 closing comment, `ff82238` |

## F. Reviewer — the self-improvement loop (SPEC §5.1)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F37 | Runs after every turn; debounced/coalesced but **no turn is skipped** | SPEC.md:237 |
| F38 | Brain is `codex exec`, small model, low effort, on the subscription | SPEC.md:238-240, ADR-0002 |
| F39 | `USER.md` **only** from registry-verified Johan-authored messages; goes quiet in autonomous runs while the watcher keeps running | SPEC.md:245-247 |
| F40 | `MEMORY.md` takes durable project facts from any provenance; Johan-authored directives weigh highest | SPEC.md:248-249 |
| F41 | A procedure creates or updates a skill in `.argus/skills/` — a repeatable *how*, and only that | SPEC.md:250-251 |
| F42 | Environment observations are facts, never skills (#71) | SPEC.md:253-262 |
| F43 | Two asks, never one: an extraction pass then a skills-writer pass, same batch, one cap slot; a memory-pass kind can never reach `.argus/skills/` (#69) | SPEC.md:264-273 |
| F44 | Weekly curator pass prunes/archives **skills** (stale 30d, archive 90d) | SPEC.md:275-277 |
| F45 | The same curator pass **deduplicates and compacts the memory files** | SPEC.md:276 |
| F46 | Creation, update and deletion are all one loop | SPEC.md:277 |
| F47 | luna@low on all four judgment eyes is the settled default; a higher tier measured *worse* | #54 closing comment, `docs/research/watcher-brain-tiers.md`, ADR-0002 |

## G. Archiver (SPEC §5.2)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F48 | Every message from every session logged to `.argus/archive.db` (SQLite + FTS5) as it happens — no LLM, no filtering | SPEC.md:281-282 |
| F49 | Exposed as `argus search "<query>"`, because a CLI is the one interface all three agents share | SPEC.md:282-283 |

## H. Honcho (SPEC §5.3)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F50 | Each exchange feeds **this repo's own** Honcho workspace | SPEC.md:287 |
| F51 | Provenance decides peer attribution, so the semantic model of Johan is never contaminated by agent-authored prompts | SPEC.md:289-291 |
| F52 | Self-hosted first: local AGPL server at `HONCHO_URL=http://localhost:8000`; managed is a URL change, not a redesign | SPEC.md:293-298 |

## I. Digest (SPEC §5.4)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F53 | A running markdown digest per session at `.argus/sessions/<ticket>-<id>.md` (`adhoc-<id>.md` when ticketless) | SPEC.md:302-303 |
| F54 | Frontmatter carries `agent`, `ticket`, `status`, `started_by`, `johan_touched` | SPEC.md:304 |
| F55 | `INDEX.md` holds one line per session; the zoom path is INDEX → digest → raw transcript | SPEC.md:305-306 |
| F56 | The digest's `status` field doubles as the §6 slow-poll signal | SPEC.md:307-308 |

## J. Retro — everything-is-a-ticket enforcement (SPEC §5.5)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F57 | Git signal: commits / working-tree changes not attributable to a registered ticket session | SPEC.md:315-316 |
| F58 | Transcript signal: the digest classifies a session as "implementation happened, no ticket claimed" | SPEC.md:317-318 |
| F59 | Scope-drift signal: for a session that IS registered, the diff against that ticket's stated scope (#38) | SPEC.md:319-321 |
| F60 | On detection, auto-file a **closed**, `retro`-labeled ticket as a sub-issue of the nearest parent, titled `Retro: <what was done>` | SPEC.md:323-327 |
| F61 | No approval queue — a wrong retro ticket is cheap, a missing one breaks the record | SPEC.md:326-327 |
| F62 | Write-policy matrix holds per destination: `USER.md` never from autonomous output; digest flags `johan_touched`; archive takes everything | SPEC.md:331-339 |

## K. Completion and blocking signals (SPEC §6)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F63 | Push: native Claude `Stop` hook and Codex `notify` — both native, neither one cmux — write an event file into `.argus/events/` | SPEC.md:347-349 |
| F64 | `argus up` installs both | SPEC.md:349 |
| F65 | The event file is the signal; the ping is best-effort and degrades **loudly**, never silently | SPEC.md:352-356 |
| F66 | Never type into an unresolved handle: the send seam resolves against cmux's own listing and degrades rather than misdelivers (#7) | SPEC.md:357-362 |
| F67 | Poll: `argus signals --repo <repo>` every 5 minutes via the repo-scoped Hermes cron | SPEC.md:363-364 |
| F68 | Push and poll share one durable `(session, status)` cursor, so a successful push is never delivered twice | SPEC.md:366-367 |
| F69 | Empty sweeps emit no stdout, so Hermes cron skips the agent turn | SPEC.md:368 |

## L. The work pipeline (SPEC §7)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F70 | The chain: `grilling → to-spec → to-tickets → implement`, plus `wayfinder` for maps and `code-review` at the end | SPEC.md:378-379 |
| F71 | Tracker is GitHub Issues per target repo — native sub-issues + blocking edges = a visible frontier | SPEC.md:379-380 |
| F72 | Grill flow: register the deployment, create a cmux workspace in R, spawn Claude with the grill skill, notify Johan to attach | SPEC.md:384-386 |
| F73 | During a grill all five watchers cover the session live; Reviewer and Honcho capture decisions as they are made | SPEC.md:387-389 |
| F74 | A grill mode's skill **id** is part of the route — a nonexistent id does not fail, it quietly does something adjacent (#62) | `src/grill/skills.ts:19-25` |
| F75 | Dispatch reads the frontier: open, unblocked, unclaimed tickets | SPEC.md:393 |
| F76 | Per ticket: claim → git worktree → new cmux workspace on that worktree → fresh session → register → dispatch | SPEC.md:394-396 |
| F77 | Concurrency cap 3, a real `.argus/config.yaml` knob enforced at the door production uses | SPEC.md:397-399, `src/dispatch/dispatch.ts:17-23` |
| F78 | On green: merge the worktree, close the ticket, update the map — the dispatcher owns ticket state, not `implement` | SPEC.md:400-402 |
| F79 | Johan can attach to any ticket workspace and take over at any time | SPEC.md:403-404 |
| F80 | Johan's ad hoc sessions get identical watcher coverage | SPEC.md:408-410 |
| F81 | Planning/grilling sessions are exempt from everything-is-a-ticket | SPEC.md:415 |
| F82 | A gate is only a gate if it can refuse: a gate that did not execute did not pass, and gates run in the ticket's worktree | `src/complete/gates.ts` docblock |

## M. Memory and skills unification (SPEC §8)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F83 | `.argus/memory/USER.md` + `MEMORY.md` per repo, written by the Reviewer and natively by Claude through the symlink | SPEC.md:423-425 |
| F84 | Hermes' native memory flush is bound to **this repo's** `.argus/memory/` pair, never the global `~/.hermes/memories/` | SPEC.md:427-430 |
| F85 | Canonical skills store `.argus/skills/` in SKILL.md format — one store, three readers, no forks | SPEC.md:434-436 |
| F86 | The Reviewer creates and updates skills; the curator retires them | SPEC.md:435-436 |
| F87 | claude-mem is retired after a one-time curation pass; Claude's built-in auto-memory is **not** retired | SPEC.md:440-444 |

## N. Supervisor (SPEC §9)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F88 | One machine-level launchd job keeps each enabled repo's five watchers running: starts on login, restarts on crash, holds no other knowledge | SPEC.md:450-454 |

## O. CLI (SPEC §10)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F89 | `argus init` is the repo-local half and nothing else: scaffold, gitignore, seed memory, migrate Claude memory in, install adapters, lay down tracker docs | SPEC.md:463-467 |
| F90 | `argus init` contacts no network and writes nothing outside the repo — safe on a repo you are only considering | SPEC.md:468-470 |
| F91 | `argus init` finishes by **verifying** the wiring it wrote rather than asserting it in prose | SPEC.md:470-472 |
| F92 | `argus up` = init + machine convergence: Honcho workspace, tracker labels, supervisor registration, push hooks, Hermes cron, memory-binding verification, start the eyes | SPEC.md:473-477 |
| F93 | cmux hooks are reported as an optional capability at the installed version's actual support, never a convergence requirement | SPEC.md:477-479 |
| F94 | Neither command commits by default; both print exactly what is unstaged and the command to run; `--commit` opts in and commits the whole set in one `chore: adopt Argus`; a partial commit is the one behaviour ruled out | SPEC.md:480-484 |
| F95 | `argus down` / `argus status` stop and inspect this repo's eyes | SPEC.md:485 |
| F96 | `argus signals [--repo]` consumes unseen durable events and runs one bounded fallback sweep | SPEC.md:486-488 |
| F97 | `argus search "<query>"` is an FTS query over `archive.db` | SPEC.md:489 |

## P. Test doctrine — the fake-Johan harness (SPEC §13)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F98 | A fake-Johan simulation driver exercises the system without Johan | SPEC.md:521-529 |
| F99 | Verdicts, not bare passes: every scenario reports STRUCTURAL or LIVE against an assertion manifest (#63) | SPEC.md:531-545 |
| F100 | LIVE is evidence-gated: a live drive retires a double from a slot only against recorded evidence the scenario itself produced (#74, #76, #78) | SPEC.md:546-587, `src/harness/verdicts.ts` |
| F101 | Test agents run in isolation: scratch tabs and worktrees only, never a real project (Johan directive 2026-08-24, amended 2026-08-25) | SPEC.md:597-604 |
| F102 | Subscription mode is the default and only required live-Claude path: real `HOME`, no token, no API key | SPEC.md:611-620 |
| F103 | Hermetic mode is optional and stricter, and refuses a real-home target *before* the untokened refusal | SPEC.md:621-632 |
| F104 | The absence of a token is never a blocking reason — it selects subscription mode | SPEC.md:633-639 |
| F105 | The mode in force is reported by name on the banner, not inferred from the environment | SPEC.md:640-646 |
| F106 | `SandboxScope` refuses paths outside the sandbox root (symlinks resolved first) and processes the harness did not spawn | SPEC.md:655-668 |
| F107 | Deployed live Claude agents run Opus 5 (`claude --model claude-opus-5`) | SPEC.md:605, `src/deploy/routes.ts:79` |

## Q. §14 — "It's working if"

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F108 | A grill session with Johan produces a digest, MEMORY.md facts, USER.md facts, Honcho observations and an archive — with **zero manual capture** | SPEC.md:704-706 |
| F109 | A 10-ticket batch runs 3 at a time in worktrees, each in a fresh attachable cmux session, and `USER.md` gains nothing because Johan typed nothing | SPEC.md:707-708 |
| F110 | A hijack is visible: `johan_touched` on the digest, the directives in memory, and a retro sub-issue plus in-ticket drift note where scope moved | SPEC.md:709-729 |
| F111 | `argus search` answers "how did we solve X" from any past session of any agent | SPEC.md:730 |
| F112 | Deleting `.argus/` in one repo harms no other repo | SPEC.md:731 |

## R. Setup phase (SPEC §11)

| # | Feature / promise | Promised at |
| --- | --- | --- |
| F113 | Hermes install repaired; Honcho provisioned self-hosted; claude-mem curated and retired; codex rollout → repo attribution solved | SPEC.md:495-500 |

## S. Standing Johan directives, and where they land

These were named in #84 as the directives that must be inventoried. Six of the eight
are already SPEC lines and are inventoried above; two add something the SPEC does not
say, and are entered as features in their own right.

| Directive | Where it lands |
| --- | --- |
| Workers as tabs that fully close | **F21** — new. SPEC.md:129 says "one cmux workspace per deployed session" and says nothing about closing it. `src/deploy/workspace.ts` creates workspaces; **no close or kill path exists anywhere in the tree.** |
| Subscription-only models on both vendors | F7 (SPEC.md:49) + F8 (SPEC.md:71) + F9 (`src/eyes/config.ts:173`) |
| Opus-max for deployed Claude agents | **F107** — partially. The model half is real (`routes.ts:79` hardcodes `claude-opus-5`); the *effort* half appears nowhere in this tree, and SPEC.md:101's agent table still says Claude Code runs "Fable". See F15. |
| Testing in isolation | F101 (SPEC.md:597), F106 (`SandboxScope`) |
| Scope-drift detection | F59 (SPEC.md:319), F110 (SPEC.md:709) |
| Fork with a tether for the skill chain | F4 (SPEC.md:35), F70 (SPEC.md:378), F74 (`src/grill/skills.ts:19`) |
| Per-repo, nothing global | F1 (SPEC.md:24), F88 (SPEC.md:453, the one exception), F112 (SPEC.md:731) |
| Provenance purity of `USER.md` | F39 (SPEC.md:245), F62 (SPEC.md:333), F109 (SPEC.md:708) |

---

**113 features.** The matrix grades every one of them.
