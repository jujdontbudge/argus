# Hermes memory binding research

Researched on 2026-08-24 for Argus issue #10. This note uses only the installed
Hermes source tree (`~/.hermes/hermes-agent/`, `hermes` v0.16.0, upstream
`9e484f05`), the live install at `~/.hermes/`, and read-only invocations of
`~/.local/bin/hermes` (`--version`, `--help`, subcommand `--help`, and a venv
Python one-liner). Nothing under `~/.hermes` was modified.

## Memory flush mechanics

### Write path

Hermes's built-in persistent memory is the `memory` tool
(`~/.hermes/hermes-agent/tools/memory_tool.py`). It maintains exactly two files —
`MEMORY.md` (agent notes) and `USER.md` (user profile) — in one directory:

- The directory is resolved dynamically at every call:
  `get_memory_dir()` returns `get_hermes_home() / "memories"`
  (`tools/memory_tool.py:55-57`). The subdirectory name `memories` is hardcoded.
- File selection: `_path_for(target)` maps `user` → `USER.md`, everything else →
  `MEMORY.md` (`tools/memory_tool.py:245-250`).
- Format: each file is a flat list of entries joined by the delimiter `\n§\n`
  (`tools/memory_tool.py:59`), char-budgeted per store: `memory_char_limit`
  default 2200, `user_char_limit` default 1375 (`tools/memory_tool.py:124`,
  defaults also in `hermes_cli/config.py:1707-1731`).
- Writes are atomic temp-file + `os.replace` rename in the same directory
  (`tools/memory_tool.py:577-606`), guarded by a sibling `.lock` file
  (`tools/memory_tool.py:208-243`; the live install shows `MEMORY.md.lock` /
  `USER.md.lock` next to the files in `~/.hermes/memories/`).
- Drift guard: before any mutation the file is re-read under lock; if the
  content would not round-trip through the §-parser, or any single parsed entry
  exceeds the store's whole-file char limit, the write is **refused** and a
  `.bak.<ts>` snapshot is taken (`tools/memory_tool.py:522-575`, the issue
  #26045 guard referenced at `tools/memory_tool.py:102`). This matters for the
  format-gap section below.

The path is **deterministic code**. The LLM-facing tool schema exposes only
`action`, `target`, `content`, `old_text` — no path parameter
(`tools/memory_tool.py:740-789`). A prompt can influence *what* is saved, never
*where*.

### Triggers ("the flush")

1. **Foreground tool calls** — the model can call `memory(action=add|replace|remove)`
   at any time; the tool description tells it to save proactively
   (`tools/memory_tool.py:740-763`).
2. **Turn-based background review (the main automatic flush)** — every
   `memory.nudge_interval` user turns (default 10, read at
   `agent/agent_init.py:1118`), the turn sets `should_review_memory`
   (`agent/turn_context.py:209-217`); after the response is delivered, a
   background fork of the agent is spawned to review the conversation and write
   memories/skills (`agent/turn_finalizer.py:391-401`,
   `agent/background_review.py:1-12`). The fork **shares the parent's
   `MemoryStore` instance** (`agent/background_review.py:419`:
   `review_agent._memory_store = agent._memory_store`), so any binding of the
   parent's store automatically covers the background flush.
3. **Compression events** — after context compression the store snapshot is
   reloaded from disk (`agent/system_prompt.py:409-414`). The
   pre-compression `commit_memory_session()` call
   (`agent/conversation_compression.py:505-506`) flushes **external memory
   provider plugins only** (`run_agent.py:2930-2939` operates on
   `_memory_manager`, not the built-in store).
4. **Gateway session expiry** — a background watcher finalizes expired gateway
   sessions (`gateway/run.py:5344-5443`; `gateway/session.py:785-789` says it
   exists "to proactively flush memories"). This is a gateway-mode concern; an
   Argus-launched interactive CLI session is covered by (1)–(3).

### Read path

At session start, `MemoryStore.load_from_disk()` reads both files, deduplicates,
threat-scans, and freezes a snapshot (`tools/memory_tool.py:132-170`); the
snapshot is injected into the system prompt
(`agent/system_prompt.py:343-352`). The store is constructed and loaded in
`agent/agent_init.py:1106-1127` when `memory.memory_enabled` or
`memory.user_profile_enabled` is true. Because both the read and write sides go
through the same dynamically-resolved `get_memory_dir()`, redirecting
`HERMES_HOME` redirects **both** — there is no second path to patch.

## Config surfaces (exhaustive)

What exists:

- **`HERMES_HOME` env var** — the single source of truth for the whole home
  directory (`hermes_constants.py:53-75`). `get_memory_dir()` re-resolves it on
  every call; the comment at `tools/memory_tool.py:51-54` states this is
  deliberate so "profile overrides (HERMES_HOME env var changes) are always
  respected." Runtime-verified with the install's own venv:

  ```
  $ HERMES_HOME=/tmp/.../fake-home venv/bin/python -c \
      "from tools.memory_tool import get_memory_dir; print(get_memory_dir())"
  /tmp/.../fake-home/memories
  ```

  Relocating `HERMES_HOME` moves *everything* with it: `config.yaml`, `.env`,
  `auth.json`, `skills/`, `sessions/`, `state.db` (`hermes_constants.py:397-414`,
  `hermes_cli/auth.py:855-856`).
- **`-p` / `--profile` CLI flag** — pre-parsed before any imports and converted
  into `os.environ["HERMES_HOME"] = <root>/profiles/<name>`
  (`hermes_cli/main.py:336-461`, the assignment at `hermes_cli/main.py:454`;
  `hermes_cli/profiles.py:1652-1668`). Profiles are Hermes's native isolation
  unit: "Each profile is a fully independent HERMES_HOME directory with its own
  config.yaml, .env, memory, sessions, skills, gateway, cron, and logs"
  (`hermes_cli/profiles.py:1-19`). Every new profile is bootstrapped with a
  `memories/` directory (`hermes_cli/profiles.py:37-53`), and `--clone` copies
  `config.yaml`, `.env`, `SOUL.md` plus `memories/MEMORY.md` and
  `memories/USER.md` (`hermes_cli/profiles.py:56-68`;
  `hermes profile create --help` confirms the flags).
- **Sticky profile** — `hermes profile use <name>` writes
  `<root>/active_profile`, which redirects *every* subsequent bare `hermes` run
  (`hermes_cli/main.py:424-436`). Argus must never use this.
- **Profile-mode auth fallback** — when `HERMES_HOME` is profile-shaped
  (`.../profiles/<name>`), providers authed at the global root remain visible
  read-only (`hermes_cli/auth.py:877-905`). A custom non-profile `HERMES_HOME`
  explicitly gets **no** fallback ("or custom HERMES_HOME that is not a
  profile" → `None`, `hermes_cli/auth.py:880-881`). This is the decisive
  difference between mechanisms 1 and 2 below.
- **In-process ContextVar override** — `set_hermes_home_override()`
  (`hermes_constants.py:16-41`) scopes a home override per task without touching
  `os.environ`. In-process only; not reachable from a spawn command.
- **Memory config keys** (`memory:` block, defaults at
  `hermes_cli/config.py:1707-1731`, live values at `~/.hermes/config.yaml:394-401`):
  `memory_enabled`, `user_profile_enabled`, `write_approval`,
  `memory_char_limit`, `user_char_limit`, `provider`, plus `nudge_interval`
  (read at `agent/agent_init.py:1118`). `provider` activates an *additive*
  external plugin (honcho, mem0, …) — it never redirects the built-in store
  (`agent/agent_init.py:1131-1144`; `hermes memory --help`: "Built-in memory
  (MEMORY.md/USER.md) is always active").

What does **not** exist (dead ends, each checked against the full source grep):

- No `memories_dir` / `memory.path` / any path key in the memory config block.
- No `HERMES_MEMORIES_DIR` env var — an enumeration of every `HERMES_[A-Z_]+`
  string in the source finds home/skills/MCP overrides (`HERMES_HOME`,
  `HERMES_BUNDLED_SKILLS`, `HERMES_OPTIONAL_SKILLS`, `HERMES_OPTIONAL_MCPS`,
  `hermes_constants.py:168-221`) but nothing memory-scoped.
- No CLI flag for the memory path; `hermes memory` subcommands are
  `setup|status|off|reset` (external providers + erase), nothing path-related.
- No project-local *config* discovery. Hermes discovers `.hermes.md` /
  `HERMES.md` context files upward from cwd (`agent/prompt_builder.py:77-88`),
  but those feed the prompt, not configuration; `config.yaml` is only ever read
  from `get_hermes_home()` (`hermes_constants.py:397-403`).
- Skills have a per-instance extension point (`skills.external_dirs`, used by
  `tools/skills_tool.py:497`); memory has **no equivalent**.
- `flush_min_turns: 6` in the live `~/.hermes/config.yaml:401` appears nowhere
  in the source — it is a dead key and should not be relied on.
- Every construction of the memories path in the tree is
  `get_hermes_home() / "memories"` (`tools/memory_tool.py:57`,
  `hermes_cli/web_server.py:7684`, `hermes_cli/main.py:10865`,
  `hermes_cli/doctor.py:1121`); none takes an independent override.

## Does a native per-repo binding exist?

**No.** There is no per-repo or per-cwd memory binding. The nearest native
construct is the **profile** — a named, fully isolated `HERMES_HOME` selected
per invocation via `-p <name>` or the `HERMES_HOME` env var. Profiles are
per-*instance*, not per-repo; making them per-repo is Argus's job at
`argus init` time.

## Ranked mechanisms

1. **Per-repo Hermes profile + memories directory symlink (recommended).**
   Create `~/.hermes/profiles/argus-<slug>/` once per repo, replace its
   `memories/` directory with a symlink to `<repo>/.argus/memory/`, launch with
   that profile. Pros: native isolation unit; both read and write paths follow
   (`tools/memory_tool.py:55-57`, `agent/background_review.py:419`); global
   OAuth/auth remains visible read-only because the home is profile-shaped
   (`hermes_cli/auth.py:877-905`); per-profile `config.yaml` lets Argus raise
   the char limits without touching global config; concurrent sessions in
   different repos use disjoint homes and disjoint lock files. Cons: profile
   `config.yaml`/`.env` are clone-time copies and can drift from global (Argus
   can re-sync at launch); Hermes sessions/logs/state fragment per profile
   (arguably desirable for Argus's provenance model).
2. **Bare `HERMES_HOME` pointing at a synthetic repo-local home**
   (e.g. `<repo>/.argus/hermes-home/` with symlinks back to global
   `config.yaml`, `.env`, `auth.json`). Works for the memory dir, but:
   non-profile-shaped homes get no global auth fallback
   (`hermes_cli/auth.py:880-881`), so `auth.json` must be file-symlinked — and
   Hermes rewrites files via atomic temp+rename, which **replaces a file-level
   symlink with a real file**, silently forking credentials on the first token
   refresh. Directory-level symlinks are safe with rename-writers; file-level
   ones are not (`tools/memory_tool.py:577-606` shows the pattern). Rejected as
   more fragile than 1 for no added benefit.
3. **Code-level patch** — teach `get_memory_dir()` a `HERMES_MEMORIES_DIR`
   override (a 3-line change at `tools/memory_tool.py:55-57`). Cleanest
   semantics, but `~/.hermes/hermes-agent` is updated in place by
   `hermes update`, so the patch dies on every upgrade and silently reverts to
   the global store — the exact failure Argus is trying to ban. Only worth
   pursuing as an upstream PR; not as the operating mechanism.
4. **Session-level instruction** ("write your memories to `.argus/memory/`") —
   **not viable as a binding.** The flush path is deterministic code; the tool
   schema has no path parameter (`tools/memory_tool.py:740-789`), and the
   automatic flush runs in a background fork the user never sees
   (`agent/turn_finalizer.py:391-401`). At best the prompt can ask the model to
   avoid the memory tool, which forfeits the native flush entirely. Useful only
   as a belt-and-suspenders note in `AGENTS.md`, never as the mechanism.
5. **Symlinking the global `~/.hermes/memories/` into a repo** — rejected
   outright. All non-Argus sessions, the gateway, and cron share that one
   directory (`gateway/run.py`, `hermes_cli/doctor.py:1121`), and two
   Argus-enabled repos cannot both hold the symlink. This is the collision case
   the per-profile design exists to avoid.

## Format gap

File **names** map 1:1 (`MEMORY.md` + `USER.md` on both sides — Hermes's pair
at `tools/memory_tool.py:245-250` vs `.argus/memory/` per SPEC §4/§8.1), but
**formats do not**:

- Hermes writes flat `\n§\n`-delimited entry lists under a hard char budget
  (`tools/memory_tool.py:59,124`).
- Argus's canonical `MEMORY.md` is a Claude-auto-memory-style index (one line
  per fact, per-fact files beside it; SPEC §4 adapter bullet), and `USER.md` is
  prose.

Consequences of sharing the files directly:

- A §-free markdown file parses as **one entry**. If it exceeds the store's
  char limit (2200/1375 default), the drift guard refuses every Hermes write
  and litters `.bak.<ts>` snapshots (`tools/memory_tool.py:522-575`). The
  per-profile `config.yaml` must therefore raise `memory_char_limit` /
  `user_char_limit` (e.g. 12000/6000) — this is profile-local and leaves global
  behavior untouched.
- Hermes appends entries as `\n§\n<entry>`, so Claude/the Reviewer will see §
  blocks after the index. The Reviewer (which already owns these files per SPEC
  §8.1) should fold § entries into the index + per-fact files as part of its
  loop — a small adapter, but a real one; the binding alone does not make the
  formats identical.
- The whole file is injected into Hermes's system prompt each session
  (`agent/system_prompt.py:343-352`), so the index must stay lean or Hermes
  pays for it every turn.

## Recommended mechanism

**Name:** *profile-scoped `HERMES_HOME` with a memories-directory symlink* — a
per-repo Hermes profile whose `memories/` directory is a symlink to the repo's
`.argus/memory/`, selected at launch via the `HERMES_HOME` environment variable.

**Once per repo, at `argus init`:**

```bash
slug=<repo-slug>                     # e.g. "argus" for /Users/johansardar/argus
hermes profile create "argus-${slug}" --clone --no-alias \
  --description "Argus orchestrator profile for ${slug} (memory bound to repo)"
rm -rf "$HOME/.hermes/profiles/argus-${slug}/memories"
ln -s "<repo>/.argus/memory" "$HOME/.hermes/profiles/argus-${slug}/memories"
# in ~/.hermes/profiles/argus-<slug>/config.yaml, set:
#   memory:
#     memory_char_limit: 12000
#     user_char_limit: 6000
```

The symlink must be the **directory**, never the individual files — Hermes's
atomic temp+rename writes land real files inside the resolved directory
(`tools/memory_tool.py:589-597`) but would replace a file-level symlink.

**Every launch (the cmux spawn command, cwd = target repo):**

```bash
cd <repo> && HERMES_HOME="$HOME/.hermes/profiles/argus-<slug>" hermes chat
```

`hermes -p argus-<slug> chat` is equivalent (it sets the same env var,
`hermes_cli/main.py:454`), but exporting `HERMES_HOME` directly is preferred:
Hermes's own convention is that subprocess spawners propagate `HERMES_HOME`
explicitly (`hermes_constants.py:64-67`, issue #18594), so everything Hermes
forks inside the session inherits the binding.

**Non-Argus repos:** unaffected. With no `HERMES_HOME` set, `get_hermes_home()`
falls back to `~/.hermes` (`hermes_constants.py:73-108`) and the global
`~/.hermes/memories/` pair keeps working exactly as today. One standing rule:
Argus must never run `hermes profile use` — the sticky `active_profile` file
would redirect every bare `hermes` invocation machine-wide
(`hermes_cli/main.py:424-436`).

**Two concurrent sessions in two Argus repos:** each cmux workspace exports a
different `HERMES_HOME`, so the two processes resolve disjoint homes, disjoint
memory directories (each symlinked to its own repo), and disjoint `.lock`
files created beside the real files (`tools/memory_tool.py:216-217`). There is
no shared global path left to collide on. Writes from the Reviewer or Claude
into the same `.argus/memory/` files are serialized against Hermes by the
re-read-under-lock + drift-guard discipline (`tools/memory_tool.py:308-315`) —
worst case Hermes refuses a write and snapshots to `.bak`, never clobbers.
