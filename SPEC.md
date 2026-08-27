# Argus — Architecture Spec

Argus is a reusable orchestration and self-learning toolkit for multi-agent software
building. It is named for Argus Panoptes, the hundred-eyed watchman of Greek myth and
Hermes' mythological counterpart: a system defined by never having all its eyes closed.

Hermes orchestrates. Claude Code and Codex work. Argus watches everything, remembers
everything, and turns everything that happens into durable structure: memory, skills,
searchable history, session digests, and tickets.

- **Toolkit repo:** `~/argus` (this repo; private GitHub, Issues is its tracker, its
  own build is charted as a wayfinder map here).
- **Per-repo instance:** `argus up` converges a self-contained `.argus/` directory
  into any target repo and starts its eyes. Every instance is fully independent.

**Status:** SPEC — approved in the grilling session of 2026-08-22. Build not started.
**Diagrams:** drawn on the live Excalidraw canvas (port 3100), exported to `diagrams/`
in this repo.

---

## 1. Design principles

1. **Everything is per-project. Nothing is global.** Memory (USER.md and MEMORY.md),
   skills, the Honcho workspace, the archive DB, digests, registry, events: all live
   under the target repo's `.argus/`. The only machine-global piece is a dumb process
   supervisor (§9) that keeps per-repo watchers alive. Global state: none. Global
   process: one, and it holds no knowledge beyond which repos are enabled.
2. **One store, many readers. Never parallel memory systems.** Each concern has exactly
   one canonical file/store per repo. Agent-specific integration is done with adapters
   (symlinks, pointer files), never with agent-specific copies. claude-mem is retired
   (§8.3).
3. **Every implemented thing is a ticket.** Planning is exempt. If work lands without a
   ticket, a retro ticket is created automatically after the fact (§7.5).
4. **Fork with a tether, never edit the cache.** The Matt Pocock skill chain
   (grilling → to-spec → to-tickets → implement, wayfinder for multi-session maps)
   runs from **pocock-plus** — Johan's fork (`~/pocock-plus`, installed globally as
   a plugin from the johan-plugins marketplace) carrying local upgrades (e.g. the tdd live-verification exit gate) plus a
   `sync-upstream` skill that merges each new upstream release without losing the
   local changes listed in its `LOCAL-CHANGES.md`. Upstream plugin-cache files are
   never edited, and Argus behavior (watchers, registry, dispatch) still layers
   around the chain rather than living inside it.
5. **Provenance-aware, always-on.** Watchers never stop; they change *how* they write
   based on who authored each message (§5). Johan's words and agent output are never
   conflated.
6. **Every session is attachable.** All deployed work runs in cmux tabs a human can
   open and type into at any moment. Johan taking over mid-ticket is a first-class
   use case, not an exception.
7. **Argus must never require Anthropic API access. Claude capability comes from
   Johan's subscription via the `claude` CLI only.** (Johan directive, 2026-08-25 —
   hard, permanent, architectural.) His plan does not permit API access, so any design
   that needs an `ANTHROPIC_API_KEY`, an `ANTHROPIC_AUTH_TOKEN`, or an out-of-band
   provisioned `CLAUDE_CODE_OAUTH_TOKEN` is, in his words, *"unusably useless"* — it
   does not run on the only machine Argus runs on. This outranks the isolation
   instinct that produced the token requirement in the first place.
   - A missing token or key is **never** a reason anything reports NOT RUN. It selects
     the subscription path; it does not block one.
   - The stricter, token-based hermetic mode (§13) may exist as an **option** for a
     machine that has one. It is never a **precondition**.
   - Stripping `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` out of a spawned child's
     environment is the *opposite* of depending on them, and stays: an ambient key
     inherited from a shell would silently change which provider — and whose quota —
     an agent runs against. Never *require* a key; never let one leak in either.
   - This is stated here, in the standing constraints, and not as a footnote in §13,
     because §13 is where it was violated: an escalation from repo-level isolation to
     a process-level one made a credential mandatory that this machine cannot mint,
     and the Claude half of the harness went unrun for it. A constraint written only
     where it is currently relevant is a constraint the next design will not read.
   - Codex/Hermes are unaffected: they run on the ChatGPT subscription via `codex`,
     which is the same shape of dependency — a CLI the user is already logged into.
8. **The same rule binds the OpenAI side: Argus never requires metered API access
   from any provider. Agent capability comes from Johan's subscriptions.** (Johan
   directive, 2026-08-26 — hard, permanent, architectural.) Item 7 was written about
   Anthropic because that is where it was violated; stating it for only one vendor is
   how the next design talks itself into a metered dependency on the other one.
   - **Every background brain runs through `codex exec` on the ChatGPT subscription** —
     Reviewer memory extraction, the skills writer, Digest, Retro including scope-drift,
     and anything else that calls a model on a schedule. These are the dangerous ones:
     they run unattended, on a cadence, forever, so a metered brain bills silently and
     without anyone deciding to spend that money.
   - A benchmark may **recommend** a model or effort that the subscription does not
     reach. When that happens, implement the closest subscription-available
     configuration and **say plainly in the ticket that the recommended one was not
     reachable** — do not quietly adopt a metered config because a measurement favoured
     it, and do not silently substitute without recording the substitution.
   - This is not merely a cost preference. A metered dependency makes Argus stop working
     the moment a credit balance runs out, on the one machine it runs on, which is the
     same failure item 7 exists to prevent.
   - Measured, not assumed: [#54](docs/research/watcher-brain-tiers.md) benchmarked the
     paid step-up per eye and found it **worse**, so the subscription default is also the
     quality default here. That is a happy accident, not the justification — the rule
     holds even where a metered option would win.

---

## 2. The agents

| Agent | Runs on | Role |
| --- | --- | --- |
| **Hermes** | ChatGPT subscription, `gpt-5.6-sol` via `openai-codex` provider | Orchestrator. Deploys, monitors, routes, nudges. **Never implements.** |
| **Claude Code** | Claude subscription, Fable | Grilling, specs, domain modeling, diagnosis, code review. |
| **Codex** | ChatGPT subscription, `gpt-5.6-sol`, high reasoning effort | Default implementer for build tickets. |

Model names above are current defaults, not commitments; both are config knobs in
`.argus/config.yaml`.

Routing is by ticket label. Hermes reads the label and picks the worker:

- `grilling`, `spec`, `review`, `diagnosis` → Claude Code
- implementation tickets (default) → Codex
- exceptions can be pinned per-ticket with an explicit `agent:claude-code` /
  `agent:codex` label.

All three agents in a given repo read the same `.argus/` stores and are watched by the
same five watchers. The watchers treat the three transcript sources uniformly:

- Claude Code: `~/.claude/projects/<project-slug>/*.jsonl`
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Hermes: `~/.hermes/sessions/` (+ `state.db`)

---

## 3. Worker surface: cmux

All deployed sessions run in the cmux macOS terminal app, driven by its CLI and socket
API (`cmux new-surface`, `close-surface`, `tree`, `send`, `send-key`, `read-screen`,
`notify`, `set-status`, `set-progress`, markdown viewer panes). Not tmux.

- **One cmux TAB per deployed session** (grill, ticket, or ad hoc), opened with
  `cmux new-surface --workspace <the workspace Argus is running in>`, and **CLOSED with
  `cmux close-surface` when the deployment ends**.

  **Argus never creates a cmux workspace.** This is Johan's standing directive
  (Directive 14 / R6) and it overrides what this section said until #95: "one cmux
  workspace per deployed session, created with `--cwd`". Production implemented that
  sentence faithfully, and #82's live drive left three top-level workspaces on Johan's
  machine pointing at its sandbox worktrees — an earlier attempt left eight. He closed
  both sets by hand. The SPEC was wrong, not the code, and #95 changed the SPEC.

  The workspace is not looked up either, because it cannot be: **cmux 0.62.2 exposes no
  working directory for a workspace anywhere** — not in `list-workspaces`, not in
  `identify`, not in `tree --json` — so there is no way to ask "which workspace is repo
  R open in", and workspace TITLES are unusable for it (cmux retitles a workspace from
  whatever its session is currently doing). Argus instead uses the workspace it is
  ALREADY RUNNING IN, via `CMUX_WORKSPACE_ID`: the dispatcher for repo R runs in R's
  workspace by construction. **One workspace per repo, opened by Johan, never by
  Argus.** No `CMUX_WORKSPACE_ID` means no tab and the deployment proceeds without one
  (§3's rule below: a tab is context, never a requirement).

- **A tab is closed when its deployment ends, both ways it can end.** Cleanly, in the
  verify/merge/close pass beside the worktree retirement (§7.3.4); and by dying, in
  dead-slot recovery (§7.3), which is the ending that actually leaks — a worker that
  crashes never reaches the clean path at all. The handles come from the registry row,
  which is the only record both endings can reach.
- **Mission control:** Hermes lives in a fixed workspace. It surfaces worker status via
  `cmux set-status`, batch progress via `cmux set-progress`, blocking events via
  `cmux notify`, and opens digest/ticket markdown panes beside workers with
  `cmux markdown open`.
- **Reading workers:** Hermes reads any worker's terminal with `cmux read-screen`
  (slow-poll path, §6) and its digest file (fast path).
- **Typing into workers:** Hermes uses `cmux send` / `cmux send-key`. **Every
  Hermes-authored send is logged to the provenance registry first** (§5). This is
  non-negotiable: unlogged sends would masquerade as Johan and poison USER.md.
- **Resume hooks are OPTIONAL (amended by #7).** `cmux hooks setup` (Claude Code) and
  `cmux hooks setup codex` are a resume *convenience*, never a dependency for signal
  delivery. §6's push path is native to the agents and cmux-independent: `argus up`
  installs a Claude Code `Stop` hook and a Codex `notify` command itself, and #7 proved
  both live end to end — a real `claude` session and a real `codex` session, hooks
  firing, events landing in `.argus/events/`, the digest watcher consuming them — with
  no cmux in the path at all. On a machine with cmux ≥ 0.64.22 the `cmux hooks`
  commands remain a supported optional extra; on 0.62.2 (this machine) they do not
  exist, and nothing in Argus requires them. Setup must never block on them.
- Automation rules from the cmux skill apply: prefixed refs always (`pane:38`),
  `--focus false` on programmatic actions, never steal focus.

---

## 4. Per-repo layout

```
<repo>/.argus/            # gitignored, machine-local operational state
  config.yaml             # instance config: repo id, tracker, caps, model choices
  registry/               # provenance registry (§5)
    sessions.jsonl        # one record per deployment: session id, agent, ticket,
                          #   dispatch prompt hash, workspace ref, tab (surface)
                          #   ref — the tab handle is what teardown closes (§3)
    sends.jsonl           # every Hermes-authored message into any session
  memory/
    USER.md               # who Johan is, in this project's context
    MEMORY.md             # durable project facts (index; per-fact files beside it)
  skills/                 # canonical per-repo skills, SKILL.md format (§8.2)
  sessions/               # digest MDs, one per session (§5.4)
    INDEX.md              # one line per session; Hermes' low-res scan
  archive.db              # SQLite FTS5 full-text archive of every message (§5.2)
  events/                 # completion/blocked events pushed by hooks (§6)
  honcho.yaml             # this repo's Honcho workspace binding (§5.3)
```

Adapters installed by `argus up` (§10):

- Claude Code's built-in memory dir (`~/.claude/projects/<slug>/memory/`) is **moved**
  into `.argus/memory/` and replaced by a symlink pointing there. Its `MEMORY.md`
  index IS the canonical `MEMORY.md`; per-fact files live beside it; the Reviewer
  writes in that same index + per-fact-file format.
- `.claude/skills/` entries symlinked from `.argus/skills/` for Claude Code.
- Hermes `skills.external_dirs` gains the repo's `.argus/skills` path.
- `AGENTS.md` gains a pointer block: memory files, skills dir, `argus search` usage.

The `.argus/` entry is a committed line in the target repo's `.gitignore`, so every
clone ignores it.

---

## 5. The five eyes (watchers)

Five **separate, independent processes** per repo. They share one transcript-tailing
library (three source formats, one event stream) but run, fail, and restart
independently. All five are always on for every session in the repo, from any of the
three agents, however it was started.

### Provenance model (what "aware" means)

The registry (`.argus/registry/`) is the single source of provenance truth:

1. Hermes records every deployment before the session starts: session id, agent,
   ticket, the full dispatch prompt.
2. Hermes records every follow-up message it types into any session (`sends.jsonl`).
3. Classification, per message:
   - Session **not** in the registry → started by Johan → user messages are
     **Johan-authored**.
   - Session in the registry → the dispatch prompt and all registry-logged sends are
     **Hermes-authored**; any other user-side message means Johan attached and typed →
     **Johan-authored**.
   - **Not every user-role record is a prompt.** Agent CLIs inject their own
     context into the transcript as user-role items — codex-cli 0.149.1 ships a
     plugin catalogue this way. An item shaped like a context envelope (an
     opening tag alone on its first line, closing with its own tag) that
     arrives in a session's **opening run** — before any prompt has landed and
     before the agent has spoken — is the CLI's injection, not a takeover, and
     classifies **system**. Both directions are audited loudly: over-filtering
     would make Argus deaf to Johan, which breaks the same invariant the other
     way round.
   - **How a prompt arrived is not provenance.** The same Hermes dispatch is
     recorded `promptSource: "typed"` when the session was opened in a terminal
     and `"sdk"` when it was opened headlessly — and Argus's own dispatcher
     spawns every worker headlessly. The same injected `<task-notification>` is
     stamped `"system"` in a terminal session and `"sdk"` in an SDK-fronted
     one — the same confusion, pointing the other way. So the
     eligibility question is only *did a prompt land here*: a record the CLI
     attributes to **itself** (`origin.kind` other than `human`, or
     `promptSource: "system"`) is not a prompt; any other record carrying a
     prompt source is. **Who** sent it stays the registry's answer, above.
     Unknown values default in opposite directions on purpose — a new
     *injection kind* is refused, a new *source name* is heard — because
     admitting an injection poisons USER.md loudly, while dropping a prompt
     makes Argus deaf to Johan silently.
4. Every watcher classifies through this one mechanism. No heuristics elsewhere.

### 5.1 Reviewer (evaluative; the self-improvement loop)

Runs after every turn — invocations are debounced/coalesced, but every turn's
content is seen; no turn is skipped. Brain: `codex exec`, small model, low reasoning
effort, on the ChatGPT subscription ([ADR-0002](docs/adr/0002-watcher-brain-defaults.md)
records the watcher-brain defaults and cadence). Decides whether anything durable
happened, with two possible destinations (memory-vs-skills split — one watcher, two
outputs):

- **A fact** →
  - `USER.md`: **only** from registry-verified Johan-authored messages, in any
    session type. During fully autonomous runs this destination naturally goes
    quiet; the watcher itself never stops.
  - `MEMORY.md`: durable project facts from **any** provenance ("Metro runs on 8082"
    is true no matter who discovered it). Johan-authored directives weigh highest.
- **A procedure** → create or update a skill in `.argus/skills/` (SKILL.md format).
  A procedure is a repeatable *how*, and only that.

**Environment observations are facts (ticket #71).** How the machine, the tools or
the repo *are* — a version floor, a required port, an empty PATH under launchd, a
tool that is not installed — is a durable project fact, and goes to `MEMORY.md`. It
is not a skill however obvious its fix looks: #54 measured the brain turning
"cmux must be ≥ 0.64.22" into a skill called *Upgrade cmux before acceptance
testing* on every attempt. The two destinations are read back for different
purposes — a fact filed as a skill is retrieved as **advice**, so Argus recommends
an environment quirk as a technique, and the deliberately narrow skills surface
fills with what is really state. Both prompts state the boundary from their own
side: the extraction pass claims the environment, the skills pass disclaims it.

**Two asks, never one (ticket #69).** Extracting a fact and writing a transferable
procedure are different jobs, and [#54's benchmark](docs/research/watcher-brain-tiers.md)
measured the brain doing the first reliably and the second not at all: at every tier
it answered the conflated ask with a topic-level summary of the episode, and invented
procedures out of status chatter and incident reports. So the eye asks **twice** per
evaluation, over the same batch: an **extraction** pass whose schema can express only
the two fact kinds, then a **skills-writer** pass whose schema can express only a
procedure and whose default is silence. Same brain tier for both, both inside one cap
slot. A kind a pass did not ask for is a schema miss, not a write — so nothing the
memory-writing pass says can reach `.argus/skills/`.

A **curator pass** (weekly, cloned from Hermes' native curator: stale after 30 days,
archive after 90) prunes and archives skills, and deduplicates/compacts the memory
files. Creation, update, and deletion are all part of this same loop.

### 5.2 Archiver (passive; zero judgment)

Logs every message from every session into `.argus/archive.db` (SQLite + FTS5) as it
happens. No LLM, no filtering, pure capture + indexing. Exposed as `argus search
"<query>"` — a CLI, because a CLI is the one interface all three agents already share.

### 5.3 Honcho (external deriver; semantic memory)

Feeds each exchange into **this repo's own** Honcho workspace (per-project,
like everything else). Honcho's Deriver runs its separate dialectic reasoning pass
server-side and maintains peer representations: Johan as the observed user peer, each
agent as its own AI peer. Provenance decides peer attribution, so the semantic model of
Johan is never contaminated by agent-authored prompts. Config: `~/.honcho/config.json`
holds credentials (the file Honcho shares across Claude Code, Cursor, etc.);
`.argus/honcho.yaml` binds the repo to its workspace. **Self-hosted first (Johan
decision, 2026-08-24 — managed honcho.dev is usage-billed with no free tier):** run
the AGPL FastAPI server locally (plastic-labs/honcho, Docker + Postgres), SDKs pointed
at it via `HONCHO_URL=http://localhost:8000`; its deriver LLM calls go to a cheap
model on Johan's own keys. Managed honcho.dev remains a URL change away if ever
wanted, not a redesign.

### 5.4 Digest (session narrative)

Appends a running markdown digest per session: `.argus/sessions/<ticket>-<id>.md`
(`adhoc-<id>.md` for ticketless sessions) with
frontmatter (`agent`, `ticket`, `status`, `started_by`, `johan_touched`), plus a
one-line-per-session `INDEX.md`. Hermes' zoom path when it wants to understand a
session: `INDEX.md` → digest → raw transcript. Same index-not-store rule as the
wayfinder map. Brain: same `codex exec` tier as the Reviewer. The digest's `status`
field doubles as the slow-poll signal (§6).

### 5.5 Retro (everything-is-a-ticket enforcement)

Detects implementation work no claimed ticket covers — and, since #38, work a ticket
does claim but never asked for. Three signals, git as ground truth:

- **Git signal:** commits / working-tree changes in the repo not attributable to a
  registered ticket session.
- **Transcript signal:** the digest classifies a session as "implementation happened,
  no ticket claimed."
- **Scope-drift signal (§14):** for a session that IS registered to a ticket, the diff
  against that ticket's stated scope. Same eye, same scan, same brain tier; the
  false-positive stance that governs it is in §14.

On detection it auto-files a **closed**, `retro`-labeled ticket: a sub-issue of the
nearest parent ticket where one exists (`gh issue create --parent <n>` — the
GitHub-legal form of "ticket 15.1"), title `Retro: <what was done>`, body derived from
Johan's prompts plus the diff. No approval queue: a wrong retro ticket is cheap to
edit; a missing one breaks the record.

### Write-policy matrix

| Destination | Autonomous agent output | Johan-authored (any session) |
| --- | --- | --- |
| `USER.md` | never | yes |
| `MEMORY.md` | yes (facts) | yes (weighted highest) |
| Skills | yes | yes |
| `archive.db` | yes (everything) | yes (everything) |
| Honcho | AI-peer observation | user-peer observation |
| Digest | yes | yes (flagged `johan_touched`) |
| Retro | yes | yes |

---

## 6. Completion and blocking signals

Push-first, poll as safety net:

- **Push:** end-of-session and blocked-on-human hooks (Claude Code `Stop` hook; Codex
  `notify` config — **both native, and neither one cmux**) write an event file into
  `.argus/events/` and ping Hermes' gateway. `argus up` installs both (`src/up/hooks.ts`).
  The Digest watcher also maintains `status:` per session
  (`running | blocked | done | dead`).
- **The event file is the signal; the ping is best-effort.** Delivery to mission control
  goes through cmux, so it is the one part of §6 that cmux can break — and when it does,
  the event stays durable and the failure is loud
  (`ARGUS EVENT DELIVERY DEGRADED: <reason>; event <id> remains durable`), never silent.
  A degraded ping is a slower Hermes, not a lost signal: the poll below still sees it.
- **Never type into an unresolved handle (#7).** cmux 0.62.2 treats an unresolvable
  `--workspace` / `--surface` as a request to act on the FOCUSED one and exits 0, so a
  stale mission handle would type `[argus]` lines into whatever human or worker session
  happened to be selected while reporting success. The send seam therefore resolves the
  handle against cmux's own listing first and degrades rather than misdelivers
  (`src/events/notify.ts`). #95 re-measured this read-only and it still holds:
  `list-pane-surfaces --workspace workspace:9999` exits 0 and answers for the focused
  workspace. Pointed at `close-surface` it would close one of Johan's tabs, so tab
  teardown resolves before it acts, exactly as the send seam does.
- **`list-workspaces` is current-window only (#95).** Measured: a caller in
  `workspace:1` gets back the OTHER window's workspaces and not its own. The resolve
  guard above therefore falls back to `cmux --id-format both tree --all --json`, the
  only whole-machine inventory, before it refuses a handle — otherwise it would refuse
  every handle outside the focused window, including the workspace every worker tab
  lives in. `--id-format both` is also what maps a `CMUX_WORKSPACE_ID` (a UUID) onto a
  ref.
- **Poll:** the repo-scoped Hermes profile runs `argus signals --repo <repo>` every
  five minutes. Each sweep reads bounded terminal candidates from `INDEX.md`, confirms
  their digest frontmatter, and resolves registered worker handles before a bounded
  `cmux read-screen`. Push delivery and polling share one durable `(session, status)`
  cursor, so a successful push is never delivered again; a degraded or absent push
  remains visible to the poll. Empty sweeps emit no stdout, so Hermes cron skips the
  agent turn. Polling alone burns Hermes turns; push alone dies silently; both together
  don't.

---

## 7. The work pipeline

### 7.1 The chain

The Matt Pocock chain as shipped by pocock-plus (§1.4): `grilling → to-spec → to-tickets → implement`, with
`wayfinder` for multi-session maps and `code-review` at the end. Tracker: GitHub Issues
per target repo (native sub-issues + blocking edges = visible frontier).

### 7.2 Grill flow (HITL)

1. Johan tells Hermes "grill X for repo R."
2. Hermes registers the deployment, opens a cmux **tab** in R's existing workspace (§3
   — never a new workspace), spawns Claude Code with the grill skill, and notifies
   Johan to attach. The notification names the **tab**, not the workspace: the
   workspace is one Johan already has open and is probably already looking at.
3. Johan answers in the terminal directly. All five watchers cover the session live;
   Reviewer and Honcho capture the decisions as they are made; the digest gives Hermes
   the planning picture without reading the whole transcript.

### 7.3 Ticket dispatch (AFK)

1. Hermes reads the frontier (open, unblocked, unclaimed tickets) from GitHub.
2. Per ticket: claim (assign) → create a **git worktree** → **a cmux tab in the existing
   workspace** (§3 — never a new workspace) → **fresh session** (one ticket, one
   session, always) → register the deployment → dispatch to the routed agent.
3. Concurrency cap: **3**, a config knob (`.argus/config.yaml`), raised only after the
   merge/verify loop proves itself. Worktrees exist because parallel agents in one
   working tree race the index.
4. On green (tests pass, review clean): merge the worktree, close the ticket, update
   the map. `implement` does not reliably close tickets itself; the dispatcher owns
   ticket state.
5. Johan can attach to any ticket tab and take over at any time; provenance
   classification and the retro watcher make this safe by construction.

### 7.4 Johan's ad hoc sessions

Sessions Johan starts himself (no registry entry) get the identical watcher coverage.
USER.md learns from him, the digest records the session, and any implementation work
without a ticket triggers the Retro watcher.

### 7.5 Every implemented thing is a ticket

Enforced by construction for dispatched work (a session exists because a ticket does)
and by the Retro watcher for everything else. Planning/grilling sessions are exempt.

---

## 8. Memory and skills unification

### 8.1 Memory files

`.argus/memory/USER.md` + `MEMORY.md`, per repo, written by the Reviewer watcher and
natively by Claude Code through the symlink adapter. Near-clones of Hermes' own memory
processes, made system-aware via provenance.

Hermes' own native memory flush is global (`~/.hermes/memories/`). When Hermes
operates in an Argus repo it must be bound to that repo's `.argus/memory/` pair,
never the global one — otherwise the parallel-store disease this spec bans returns
through the orchestrator itself. Binding mechanism: setup-phase ticket (§11).

### 8.2 Skills

Canonical store `.argus/skills/`, SKILL.md format (the format Claude Code and Hermes
both speak). Adapters per §4. One store, three readers, no forks. The Reviewer creates
and updates skills; the curator retires them.

### 8.3 claude-mem retirement

claude-mem (plugin) is uninstalled after a one-time curation pass: its SQLite DB
(`observations`, `session_summaries`, `user_prompts`) is mined and the critical,
hard-to-rediscover entries are migrated into the relevant repos' `MEMORY.md`. Claude
Code's built-in auto-memory is NOT retired; the symlink makes it a first-class writer
of the canonical store.

---

## 9. Supervisor

One machine-level launchd job. It reads the registry of Argus-enabled repos
(`~/.argus-repos` or equivalent), and keeps each repo's five watchers running:
starts them on login, restarts them on crash. It makes no decisions and holds no
knowledge beyond the list of enabled repos. This is the single exception to
"nothing global."

Each watcher has a hard RSS ceiling of **512 MiB** by default, configurable with
`ARGUS_WATCH_MAX_RSS_MB`. It checks its own resident memory on every poll and exits
cleanly after logging the measured RSS and configured ceiling when the cap is
crossed; the supervisor then performs the logged restart.

Watcher restarts use exponential backoff from one second up to 60 seconds. After
five restarts for the same repo/eye within five minutes, the supervisor gives up
until that rolling window clears instead of spinning forever. The base delay, cap,
limit, and window are configurable with `ARGUS_SUPERVISOR_RESTART_MS`,
`ARGUS_SUPERVISOR_RESTART_MAX_MS`, `ARGUS_SUPERVISOR_RESTART_LIMIT`, and
`ARGUS_SUPERVISOR_RESTART_WINDOW_MS`. Watcher exits, retry delays, and brakes are
written to `~/Library/Logs/Argus/supervisor.log` by the LaunchAgent.

Test harnesses set `ARGUS_SUPERVISOR_CONTROL=disabled`, and a `HOME` under a
temporary directory cannot register a LaunchAgent unless the dedicated launchd
test explicitly sets `ARGUS_ALLOW_SCRATCH_LAUNCHD=1`. Thus a sandbox `argus up`
cannot leave a keepalive job in the user's GUI domain after its worker dies.

**#81 workstream D soak acceptance:** after a warm-up sample, record every eye's
RSS and PID at fixed intervals for multiple hours. RSS must have no sustained
positive slope or unbounded high-water growth, every eye must stay below its hard
ceiling, and the PID set plus supervisor restart log must show zero unplanned
restarts. A ceiling-triggered restart fails the soak; it is a last-resort brake,
not evidence that memory use is flat.

---

## 10. CLI

`argus` (installed from this repo; implementation and packaging rationale:
[ADR-0001](docs/adr/0001-implementation-stack-bun-typescript.md)):

- `argus init` — the REPO-LOCAL half of setup, and nothing else: idempotently
  scaffold `.argus/`, gitignore it, seed the canonical `.argus/memory/USER.md` +
  `MEMORY.md` pair that everything else points at, migrate any existing Claude Code
  built-in memory in as seed content, install the memory symlink + skills adapters +
  AGENTS.md pointer block, and lay down the Matt Pocock tracker docs if missing. It
  contacts no network and writes nothing outside the repo — no `~/.codex`, no
  `~/.hermes`, no supervisor registry, no launchd, no started process — so it is safe
  on a repo you are only considering adopting. It finishes by VERIFYING the wiring it
  wrote (every AGENTS.md pointer resolves; a canonical skill reads back through
  `.claude/skills`) rather than asserting it in prose.
- `argus up` — `argus init` followed by machine convergence: create the repo's Honcho
  workspace, create tracker labels (`retro`, wayfinder set), register the repo with
  the supervisor, install the §6 push hooks (Claude `Stop` + Codex `notify`), install
  the repo-scoped Hermes slow-poll cron, verify the Hermes memory binding points at
  this repo's pair (§8.1), and start this repo's eyes. cmux hooks are reported as an
  optional capability — the installed version's actual support, never a pending item
  — and are never a convergence requirement (§3, §11.6, #7).
- **Neither command commits on your behalf by default.** Both write `.gitignore`,
  `AGENTS.md` and `docs/agents/`; both then print exactly which of those are not yet
  in git and the `git add`/`git commit` to run. `--commit` opts in, and commits that
  whole set — as it stands in the working tree — in one `chore: adopt Argus` commit.
  A partial commit made without asking is the one behaviour explicitly ruled out.
- `argus down | status` — stop/inspect this repo's eyes.
- `argus signals [--repo <path>]` — consume unseen durable events and run one bounded
  INDEX/digest/read-screen fallback sweep; normally invoked by the installed Hermes
  cron job.
- `argus search "<query>"` — FTS query over `archive.db`. Cost is linear in the
  number of rows a query *matches* (~0.7–0.9 ms per 1,000 matched rows, measured);
  there is deliberately no stated latency budget here, because no consumer in the
  tree states a tolerance. See ADR-0003 for the constant, the consumers, and the
  threshold pre-registered against it.

---

## 11. Setup phase (known fog → wayfinder tickets, not solved here)

1. **Repair Hermes install** — `~/.local/bin/hermes` points at a venv that no longer
   exists (`~/.hermes/hermes-agent/venv/bin/hermes`).
2. **Provision Honcho (self-hosted)** — local plastic-labs/honcho instance (Docker +
   Postgres), `HONCHO_URL` wired into `~/.honcho/config.json` and `~/.hermes/.env`.
3. **claude-mem curation pass** — mine the DB, migrate, uninstall (§8.3).
4. **Codex rollout → repo attribution** — rollouts are date-filed, not repo-filed; the
   tailing library needs a reliable cwd/repo extraction from rollout content.
5. **Hermes `argus-orchestrator` skill** — teaches Hermes the deploy/registry/dispatch
   protocol (§3, §5, §7).
6. **cmux hooks (OPTIONAL, #7)** — `cmux hooks setup` + `cmux hooks setup codex` on
   cmux ≥ 0.64.22, for resume convenience only; verify Hermes resume support. Not a
   dependency of §6 signal delivery, and absent on cmux 0.62.2 without consequence.
7. **Watcher brains wiring** — `codex exec` invocation pattern, debounce cadence,
   model/effort knobs in `.argus/config.yaml`.
8. **Hermes memory binding** — redirect Hermes' native memory flush to the active
   repo's `.argus/memory/` pair when working an Argus repo (§8.1).
9. **Send↔transcript matching** — reliably match `sends.jsonl` entries to transcript
   messages (content hash + timestamp window); the load-bearing edge of provenance
   classification.

## 12. Out of scope (v1)

- Any non-macOS host; anything beyond the three named agents; multi-machine sync;
  editing Matt Pocock plugin internals; auto-dispatch without a human-approved ticket
  breakdown; retiring Claude Code's built-in memory.

## 13. Simulation testing — the fake-Johan harness

Argus is verified end-to-end and adversarially, not just by per-ticket TDD. The
harness runs against a throwaway sandbox repo (converged with `argus up` for the
occasion) with a **simulation driver** agent that plays Johan: it types into deployed
sessions via `cmux send`, starts random unregistered sessions on both Claude Code and
Codex, makes untracked implementation edits, and drops preference statements mid-run.
Every feature ships with its scenario; pass/fail is asserted by the harness, never
eyeballed.

**Verdicts, not bare passes (ticket #63).** A green scenario states only that its
own assertions held, and every slot in the core suite runs against substituted
components — fixture eye brains, a fake `gh`, an in-memory Honcho, a stub `cmux`,
hand-authored hook payloads. So no scenario reports a bare pass. Each reports a
**STRUCTURAL** or **LIVE** verdict, graded against an assertion manifest derived
from the scenario text below rather than from whatever the slot happens to
assert, so a requirement this section states and no slot covers is printed as a
gap instead of being defined out of existence by the assertion list. LIVE is
unreachable by declaration: it requires evidence recorded from an agent the
scenario itself spawned. The one path that earns it is the opt-in FULL
real-driver journey (`ARGUS_LIVE_FULL_JOURNEY=1`), which starts the simulation
driver against real agents and then runs production's own watcher processes over
what they wrote. It has its own gate — `ARGUS_LIVE_AGENTS` does not open it,
because it costs far more — and the same three statuses as every other live half.

**What the journey renders LIVE (ticket #74).** One drive, two subscription
calls, three separately graded slots: **1** (a live session ran end to end and
production's archiver stored its words), **4** (USER.md read back byte-for-byte
across a live session, where the fixture slot only infers it untouched) and
**6** (the real archiver killed while a LIVE agent's transcript is in front of
it, and the supervisor's replacement held to an exact count taken from
production's own repo-scoped transcript source — none lost, none duplicated).
The core ten still grade STRUCTURAL, because they still run on doubles; the
live renderings are additional, never a re-grade of a fixture slot. Nothing
below is reached by a fake spawner: adding one would let a fixture run record
live evidence and grade LIVE, which is the overclaim these verdicts exist to
delete, so a requirement a live drive cannot honestly reach stays UNCOVERED or
PARTIAL and prints why.

**What the real-brain gate renders (ticket #77).** The eight core slots that
declare a `brain` double have additive `*-real-brain` renderings behind
`ARGUS_LIVE_WATCHER_BRAINS=1`: **1, 2, 3, 6, 7, 8, 9 and 10**. They rerun the
same slot handlers and assertions, sequentially, with production's existing
`createCodexBrain` path at ADR-0002's settled `gpt-5.6-luna` / low defaults.
Only slots 1, 2, 3, 7 and 8 ask a judgment question and spend calls; slots 6,
9 and 10 retire the blanket declaration without inventing a call they do not
need. All eight remain **STRUCTURAL**: no live agent was spawned, every other
declared double stays declared, and the run records no live-agent evidence.
The default core renderings remain unchanged because their fixture brains
remain what runs in a default `bun test`.

**What a live drive retires FROM A SLOT (ticket #78).** LIVE is one axis; the
DOUBLES a slot ran on are another, and #78 moved the second. Behind its own gate
(`ARGUS_LIVE_SLOTS=1`) slots **4** and **5** run their own bodies, their own
assertions and their own manifests with a real CLI on the other end of every
message — codex for 4, Claude for 5 — through `ProvenanceScenarioDriver`, the
seam #25 shipped for exactly this. Those slots' `agent` double is retired: a
live session took the dispatch and every nudge as its own turns and wrote its
own transcript. They stay **STRUCTURAL**, because `cmux` and `hermes` are
untouched by a live agent — the registry rows are still appended by the harness
and no `cmux send` carried anything. A double comes off only on a report
carrying live evidence, so the default run of every slot keeps every double it
declares. The other eight slots are NOT live-drivable and the reason is in
`live-slots.ts`: 1, 2, 3, 7 and 9 chain halves that script what the ASSISTANT
says, which no live agent can be made to do without a prompt nobody logged —
which is a Johan takeover, and would break the slots it was meant to serve.

**What driving a slot live actually found.** Two production defects, both of
the class §13 exists to catch, neither reachable from a fixture: a Hermes
bang-send lands VERBATIM in a headless session (bash mode is a TUI feature)
where only the interactive `<bash-input>` form was derived; and codex-cli now
packs `<recommended_plugins>` and `<environment_context>` into ONE user-role
item, which the single-envelope synthetic-preamble filter missed. Each would
have made a message the CLI or Hermes produced read as a Johan takeover, i.e.
put it in `USER.md` and flip `johan_touched`. Both are fixed.

**Test agents and isolation (Johan directive, 2026-08-24; amended 2026-08-25).** The
governing rule is the original one, and it is defined at the **repo** level: every
agent that runs uses the throwaway sandbox repo and scratch tabs/worktrees only,
never the production dispatcher, live worker sessions, real `~/argus` state, or a
non-sandbox session. No test run touches a non-sandbox session.

Live testing — the simulation driver, sessions under test and per-ticket live drives
— uses **Codex sol high** (`codex -c model_reasoning_effort=high`, gpt-5.6-sol) and
**Claude Opus 5** (`claude --model claude-opus-5`). Codex's one permitted credential
touchpoint is copying `auth.json` into the scratch `CODEX_HOME`.

The Claude half runs in **one of two modes**, and per §1 the default one needs no
credential at all.

**Subscription mode is the DEFAULT and the only REQUIRED live-Claude path**
(`createSubscriptionAgentSpawner`; gate `ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1`, and
`ARGUS_LIVE_AGENTS=1` opens it too). It spawns a normal terminal Claude session:
**real `HOME`, so subscription auth simply works, and no token and no API key at
all**, with `cwd` set to the throwaway sandbox repo or one of its worktrees. Its
transcript lands in `~/.claude/projects/<sandbox-slug>/` under its own slug, touching
no other project's transcripts. It refuses a `cwd` outside the sandbox, and it strips
`CLAUDE_CONFIG_DIR` and all three credential variables so nothing can silently change
which provider — or whose quota — the session runs against.

**Hermetic mode is OPTIONAL and stricter** (`createIsolatedAgentSpawner`, gate
`ARGUS_LIVE_AGENTS`), for a machine whose owner *has* a separately provisioned
`CLAUDE_CODE_OAUTH_TOKEN` and wants an OS-enforced boundary. The harness injects that
token into the Claude child environment only; it never persists it, reads a Keychain
secret, copies `~/.claude/.credentials.json`, invokes `claude setup-token`, or points
Claude at the real config. It **refuses** any `HOME` or `CLAUDE_CONFIG_DIR` under the
real home, and that refusal is raised *before* the untokened refusal, so provisioning
a token can never become the way to silence a real-home mistake. Both refusals stay
exactly as #41 and #43 wrote them: a caller who **named** the hermetic spawner asked
for an OS boundary, and handing them a real-home session instead would be the
differ-by-omission failure this section forbids.

**Per §1, the absence of a token is never a blocking reason.** It selects subscription
mode. No path in the harness may report the Claude half NOT RUN for a missing token or
key; the only remaining blocking reason on the Claude side is a missing `claude` CLI.
When the stricter mode is simply not selected, its drive is **SKIPPED** — nobody asked
for it, and the Claude half is running in the other mode — never NOT RUN, which would
report a gap that does not exist.

**How the modes stay distinct, now that one gate opens both.** Not by environment
variable — by name. `createSubscriptionAgentSpawner` is the only function in the tree
that puts the real `HOME` into a child process, and it must be called by name, with a
`SandboxScope`, to do so. No env var reaches the real home, and no spawner silently
becomes the other one. The gate chooses which drive *registers*; a spawner cannot
change what it *is*.

**Why #41's credential hazard does not apply to subscription mode.** That risk was
specific: a **copied** `.credentials.json` inside a scratch config is a second copy
of a rotating credential, and letting it refresh can revoke the one Johan's live
sessions are using. Nothing is copied here. A normal terminal session refreshes on
**the same `~/.claude` path every one of Johan's live sessions already uses**, so
there is no second copy and nothing to rotate out from under anyone. Copying that
file remains forbidden in both modes.

**Subscription mode's residual risk, stated plainly.** The blast radius is **not
OS-enforced**. The session runs under the real `HOME` and can in principle read it;
it spends Johan's own subscription quota; it appears in his session list; and it
leaves slug directories under the real `~/.claude/projects/` that the harness
deliberately does not clean up, because removing anything under the real home is the
class of operation this section exists to prevent. What replaces the OS boundary is
**scripted scope**: a sandbox `cwd`, a dispatch that asks only for benign scripted
work with no tools, and `SandboxScope` — through which every destructive and
harness-side operation runs, refusing by name any path outside the sandbox root
(resolving symlinks first) and any process this harness did not itself spawn.
Scenario 6's watcher kills adopt only watchers whose repo is the sandbox's, because
the production dispatcher supervises the real `~/argus` on the same machine. That
scoping is the safety property in this mode, so it is asserted directly in
`src/harness/sandbox-scope.test.ts` rather than left as a convention.

Whichever mode ran must be reported by name, on the gate banner, so a subscription
call is never spent quietly. Claude cases are **NOT RUN** unless a live drive actually
executed, never rounded up from fixtures or Codex results.

Core scenario suite (each maps to an eye or a provenance edge):

1. **Autonomous batch, zero human input** — run a ticket batch end to end. Assert:
   `USER.md` byte-identical, `MEMORY.md` gained project facts, digests + INDEX
   updated, archive grew, tickets closed.
2. **Fake-Johan takeover** — driver attaches mid-ticket and types directives. Assert:
   `johan_touched: true`, USER.md learned, Honcho logged a user-peer observation.
3. **Rogue session** — random unregistered session implements something with no
   ticket. Assert: closed `retro` sub-issue filed, correct parent, body reflects the
   prompts and diff.
4. **The poisoning test** — Hermes sends registry-logged nudges into a session.
   Assert: classified Hermes-authored, USER.md untouched.
5. **Fault injection: the unlogged send** — deliberately send into a session without
   registry logging. Document and assert the failure mode is visible, not silent.
6. **Watcher death** — kill each watcher mid-run. Assert: supervisor restarts it and
   the archiver backfills from the transcript with no message lost.
7. **Signal paths** — finish and block sessions with hooks disabled. Assert: the
   slow-poll fallback still surfaces both within its interval.
8. **Self-learning loop** — repeat a novel procedure across sessions. Assert: the
   Reviewer writes a skill; a planted stale skill is curated out.
9. **Semantic isolation** — query the repo's Honcho workspace. Assert: the Johan
   representation derives only from Johan-authored messages.
10. **Blast-radius zero** — wipe the sandbox repo's `.argus/`. Assert: no other
    repo's instance noticed.

The harness is itself a build deliverable (its tickets ride the normal chain), and
every §5-§7 feature ticket's acceptance criteria must name the scenario that grades it.

## 14. It's working if

- A grill session run through Hermes ends with: decisions in the digest, durable facts
  in MEMORY.md, Johan-authored preferences in USER.md, the exchange in Honcho and
  `archive.db` — with zero manual capture.
- A 10-ticket batch executes 3-at-a-time in worktrees, every ticket a fresh attachable
  cmux session, and USER.md gains **nothing** unless Johan actually typed.
- Johan hijacks a ticket mid-run, steers it by hand, and the record shows it:
  `johan_touched: true`, his directives in memory, a retro sub-issue for any
  out-of-scope work he did.

  **In-ticket scope drift is detected in v1** (#37/#38). The two §5.5 signals only
  catch work no ticket *claims*; when the hijacked session IS registered to a ticket,
  git attributes its commits to that ticket and its digest carries one, so nothing
  looks anomalous. The Retro eye therefore asks a third question, on the same scan
  and the same watcher: the session's actual diff against the ticket's **stated
  scope** (title + body, read back through the `gh` seam — closed tickets included),
  judged by the same `codex exec` brain tier as every other eye. A confirmed drift
  files a closed `retro` sub-issue **of that ticket**, naming it, quoting its stated
  scope and describing the out-of-scope work.

  **The burden of proof is on drift, and ambiguity resolves to silence.** An in-scope
  refactor, test update, rename, dependency change or gate fix is NOT drift, however
  little the ticket mentioned it; only work serving a *different goal* than the ticket
  states is. A ticket whose body states too little to measure a diff against (empty, or
  a one-liner) is not judged at all. This asymmetry is deliberate and is enforced in
  code, not just asked for in the prompt: one false positive costs trust in every retro
  Argus files, while a missed drift costs one un-filed issue.
- `argus search` answers "how did we solve X" from any past session of any agent.
- Deleting a repo's `.argus/` harms no other repo. Nothing global held knowledge.
