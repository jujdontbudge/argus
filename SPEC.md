# Argus — Architecture Spec

Argus is a reusable orchestration and self-learning toolkit for multi-agent software
building. It is named for Argus Panoptes, the hundred-eyed watchman of Greek myth and
Hermes' mythological counterpart: a system defined by never having all its eyes closed.

Hermes orchestrates. Claude Code and Codex work. Argus watches everything, remembers
everything, and turns everything that happens into durable structure: memory, skills,
searchable history, session digests, and tickets.

- **Toolkit repo:** `~/argus` (this repo; private GitHub, Issues is its tracker, its
  own build is charted as a wayfinder map here).
- **Per-repo instance:** `argus init` installs a self-contained `.argus/` directory
  into any target repo. Every instance is fully independent.

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
4. **Layer, never fork.** The Matt Pocock skill chain (grilling → to-spec → to-tickets
   → implement, wayfinder for multi-session maps) is used as shipped. Argus adds
   watchers, a registry, and dispatch around it. Plugin-cache files are never edited.
5. **Provenance-aware, always-on.** Watchers never stop; they change *how* they write
   based on who authored each message (§5). Johan's words and agent output are never
   conflated.
6. **Every session is attachable.** All deployed work runs in cmux workspaces a human
   can open and type into at any moment. Johan taking over mid-ticket is a first-class
   use case, not an exception.

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
API (`cmux new-workspace`, `send`, `send-key`, `read-screen`, `notify`, `set-status`,
`set-progress`, markdown viewer panes). Not tmux.

- **One cmux workspace per deployed session** (grill, ticket, or ad hoc), created with
  `--cwd` set to the target repo (or the ticket's worktree, §7.3), named
  `<repo>/<ticket-or-purpose>`.
- **Mission control:** Hermes lives in a fixed workspace. It surfaces worker status via
  `cmux set-status`, batch progress via `cmux set-progress`, blocking events via
  `cmux notify`, and opens digest/ticket markdown panes beside workers with
  `cmux markdown open`.
- **Reading workers:** Hermes reads any worker's terminal with `cmux read-screen`
  (slow-poll path, §6) and its digest file (fast path).
- **Typing into workers:** Hermes uses `cmux send` / `cmux send-key`. **Every
  Hermes-authored send is logged to the provenance registry first** (§5). This is
  non-negotiable: unlogged sends would masquerade as Johan and poison USER.md.
- **Resume hooks:** `cmux hooks setup` (Claude Code) and `cmux hooks setup codex` are
  part of machine setup; cmux natively supports resume for Claude Code, Codex, and
  Hermes.
- Automation rules from the cmux skill apply: prefixed refs always (`pane:38`),
  `--focus false` on programmatic actions, never steal focus.

---

## 4. Per-repo layout

```
<repo>/.argus/            # gitignored, machine-local operational state
  config.yaml             # instance config: repo id, tracker, caps, model choices
  registry/               # provenance registry (§5)
    sessions.jsonl        # one record per deployment: session id, agent, ticket,
                          #   dispatch prompt hash, workspace ref
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

Adapters installed by `argus init` (§10):

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
4. Every watcher classifies through this one mechanism. No heuristics elsewhere.

### 5.1 Reviewer (evaluative; the self-improvement loop)

Runs after every turn — invocations are debounced/coalesced, but every turn's
content is seen; no turn is skipped. Brain: `codex exec`, small model, low reasoning effort, on
the ChatGPT subscription. Decides whether anything durable happened, with two possible
destinations (memory-vs-skills split — one watcher, two outputs):

- **A fact** →
  - `USER.md`: **only** from registry-verified Johan-authored messages, in any
    session type. During fully autonomous runs this destination naturally goes
    quiet; the watcher itself never stops.
  - `MEMORY.md`: durable project facts from **any** provenance ("Metro runs on 8082"
    is true no matter who discovered it). Johan-authored directives weigh highest.
- **A procedure** → create or update a skill in `.argus/skills/` (SKILL.md format).

A **curator pass** (weekly, cloned from Hermes' native curator: stale after 30 days,
archive after 90) prunes and archives skills, and deduplicates/compacts the memory
files. Creation, update, and deletion are all part of this same loop.

### 5.2 Archiver (passive; zero judgment)

Logs every message from every session into `.argus/archive.db` (SQLite + FTS5) as it
happens. No LLM, no filtering, pure capture + indexing. Exposed as `argus search
"<query>"` — a CLI, because a CLI is the one interface all three agents already share.

### 5.3 Honcho (external deriver; semantic memory)

Feeds each exchange into **this repo's own** managed-Honcho workspace (per-project,
like everything else). Honcho's Deriver runs its separate dialectic reasoning pass
server-side and maintains peer representations: Johan as the observed user peer, each
agent as its own AI peer. Provenance decides peer attribution, so the semantic model of
Johan is never contaminated by agent-authored prompts. Config: `~/.honcho/config.json`
holds credentials (the file Honcho shares across Claude Code, Cursor, etc.);
`.argus/honcho.yaml` binds the repo to its workspace. Managed honcho.dev first;
self-hosting later is a URL change, not a redesign.

### 5.4 Digest (session narrative)

Appends a running markdown digest per session: `.argus/sessions/<ticket>-<id>.md`
(`adhoc-<id>.md` for ticketless sessions) with
frontmatter (`agent`, `ticket`, `status`, `started_by`, `johan_touched`), plus a
one-line-per-session `INDEX.md`. Hermes' zoom path when it wants to understand a
session: `INDEX.md` → digest → raw transcript. Same index-not-store rule as the
wayfinder map. Brain: same `codex exec` tier as the Reviewer. The digest's `status`
field doubles as the slow-poll signal (§6).

### 5.5 Retro (everything-is-a-ticket enforcement)

Detects implementation work no claimed ticket covers. Two signals, git as ground truth:

- **Git signal:** commits / working-tree changes in the repo not attributable to a
  registered ticket session.
- **Transcript signal:** the digest classifies a session as "implementation happened,
  no ticket claimed."

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
  `notify` config — both native) write an event file into `.argus/events/` and ping
  Hermes' gateway. The Digest watcher also maintains `status:` per session
  (`running | blocked | done | dead`).
- **Poll:** Hermes cron sweeps `INDEX.md` + `cmux read-screen` on a slow interval as
  backup. Polling alone burns Hermes turns; push alone dies silently; both together
  don't.

---

## 7. The work pipeline

### 7.1 The chain

The Matt Pocock chain, unmodified: `grilling → to-spec → to-tickets → implement`, with
`wayfinder` for multi-session maps and `code-review` at the end. Tracker: GitHub Issues
per target repo (native sub-issues + blocking edges = visible frontier).

### 7.2 Grill flow (HITL)

1. Johan tells Hermes "grill X for repo R."
2. Hermes registers the deployment, creates a cmux workspace in R, spawns Claude Code
   with the grill skill, and notifies Johan to attach.
3. Johan answers in the terminal directly. All five watchers cover the session live;
   Reviewer and Honcho capture the decisions as they are made; the digest gives Hermes
   the planning picture without reading the whole transcript.

### 7.3 Ticket dispatch (AFK)

1. Hermes reads the frontier (open, unblocked, unclaimed tickets) from GitHub.
2. Per ticket: claim (assign) → create a **git worktree** → new cmux workspace on that
   worktree → **fresh session** (one ticket, one session, always) → register the
   deployment → dispatch to the routed agent.
3. Concurrency cap: **3**, a config knob (`.argus/config.yaml`), raised only after the
   merge/verify loop proves itself. Worktrees exist because parallel agents in one
   working tree race the index.
4. On green (tests pass, review clean): merge the worktree, close the ticket, update
   the map. `implement` does not reliably close tickets itself; the dispatcher owns
   ticket state.
5. Johan can attach to any ticket workspace and take over at any time; provenance
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

---

## 10. CLI

`argus` (installed from this repo):

- `argus init` — scaffold `.argus/` in the current repo, gitignore it, create the
  repo's Honcho workspace, migrate any existing Claude Code built-in memory into
  `.argus/memory/` as seed content, install the memory symlink + skills adapters +
  AGENTS.md pointer block, create tracker labels (`retro`, wayfinder set), verify
  the Matt Pocock tracker wiring (`setup-matt-pocock-skills`) and lay it down if
  missing, register the repo with the supervisor, verify cmux hooks.
- `argus up | down | status` — start/stop/inspect this repo's watchers.
- `argus search "<query>"` — FTS query over `archive.db`.

---

## 11. Setup phase (known fog → wayfinder tickets, not solved here)

1. **Repair Hermes install** — `~/.local/bin/hermes` points at a venv that no longer
   exists (`~/.hermes/hermes-agent/venv/bin/hermes`).
2. **Provision managed Honcho** — account, API key (`HONCHO_API_KEY` is empty in
   `~/.hermes/.env`), `~/.honcho/config.json`.
3. **claude-mem curation pass** — mine the DB, migrate, uninstall (§8.3).
4. **Codex rollout → repo attribution** — rollouts are date-filed, not repo-filed; the
   tailing library needs a reliable cwd/repo extraction from rollout content.
5. **Hermes `argus-orchestrator` skill** — teaches Hermes the deploy/registry/dispatch
   protocol (§3, §5, §7).
6. **cmux hooks** — `cmux hooks setup` + `cmux hooks setup codex`; verify Hermes
   resume support.
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
harness runs against a throwaway sandbox repo (`argus init`'d for the occasion) with
a **simulation driver** agent that plays Johan: it types into deployed sessions via
`cmux send`, starts random unregistered sessions on both Claude Code and Codex, makes
untracked implementation edits, and drops preference statements mid-run. Every feature
ships with its scenario; pass/fail is asserted by the harness, never eyeballed.

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
- `argus search` answers "how did we solve X" from any past session of any agent.
- Deleting a repo's `.argus/` harms no other repo. Nothing global held knowledge.
