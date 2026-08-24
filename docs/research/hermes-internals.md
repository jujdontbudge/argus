# Hermes internals: session format and event ingestion

Researched on 2026-08-24 for Argus issue #12. Sources: the installed Hermes
source tree (`~/.hermes/hermes-agent/`, `hermes` v0.16.0), the live install at
`~/.hermes/` (read-only sqlite queries against `state.db`), `hermes … --help`
output, and one throwaway run of `hermes chat -q` under a scratch
`HERMES_HOME` in the session scratchpad. Nothing under `~/.hermes` was
modified; no processes were left running. Line numbers refer to files under
`~/.hermes/hermes-agent/`.

**TL;DR for the spec:** the SPEC §2 line "Hermes: `~/.hermes/sessions/` (+
`state.db`)" has it backwards. `state.db` is the canonical — and only —
turn-structured transcript store; `sessions/` holds debug breadcrumbs
(`request_dump_*.json`) and nothing else by default. And SPEC §6's "ping
Hermes' gateway" only exists if a separate `hermes gateway` process is
running; a cmux-resident interactive Hermes session listens on nothing.

## 1. Session persistence — where turns actually live

- The `~/.hermes/sessions/` directory is the agent's **logs dir**:
  `agent.logs_dir = hermes_home / "sessions"` (`agent/agent_init.py:1032`).
  The `request_dump_*.json` files observed there are API-request debug
  breadcrumbs written on request failures/debug triggers by
  `agent/agent_runtime_helpers.py:1151`
  (`request_dump_{session_id}_{timestamp}.json`). Runtime-verified structure:
  top-level keys `{timestamp, session_id, reason, request, error}` — a raw
  provider request payload plus error info, **not** a turn transcript.
- Per-session JSON transcripts in that dir are **opt-in and off by default**:
  `sessions.write_json_snapshots` (default `False`), with the comment
  "state.db is canonical — the snapshot is only useful for external tooling
  that reads the JSON files directly" (`agent/agent_init.py:1035-1042`;
  writer `run_agent.py:2192-2195`).
- The canonical store is **SQLite**: `DEFAULT_DB_PATH = get_hermes_home() /
  "state.db"` (`hermes_state.py:34`), module docstring: "history, and model
  configuration for CLI and gateway sessions" (`hermes_state.py:7`).
  Schema DDL at `hermes_state.py:440-580`; live schema dump matches.
- Writes are **incremental during the turn**, not end-of-session batch:
  `_persist_session()` → `_flush_messages_to_session_db()`
  (`run_agent.py:1479-1488`, `1548-1606`) is called at turn start
  ("Crash-resilience: persist the inbound user turn as soon as the session
  row exists", `agent/turn_context.py:238-240`) and from ~15 sites in
  `agent/conversation_loop.py` (841, 1238, 1400, 1731, 2419, …). A
  `_last_flushed_db_idx` cursor prevents duplicate writes
  (`run_agent.py:1548-1558`). Runtime-verified twice: (a) recent cron
  sessions' message timestamps span the whole run rather than clustering at
  exit; (b) the scratch run below persisted the user message even though the
  provider call failed with a 401.

## 2. Record format + extraction recipe

`state.db` tables (from the live schema; DDL `hermes_state.py:440-509`):

- **`sessions`**: `id TEXT PRIMARY KEY`, `source TEXT` (observed values:
  `cli`, `cron`, `whatsapp`), `model`, `parent_session_id`,
  `started_at REAL`, `ended_at REAL`, `end_reason TEXT`, `message_count`,
  `tool_call_count`, token/cost columns, `title`, `cwd`, `rewind_count`,
  `archived`. `started_at`/`ended_at` are unix epoch floats (`time.time()`,
  `hermes_state.py:1218-1225`).
- **`messages`**: `id INTEGER PRIMARY KEY AUTOINCREMENT`,
  `session_id TEXT REFERENCES sessions(id)`, `role TEXT`, `content TEXT`,
  `tool_call_id`, `tool_calls` (JSON), `tool_name`, `timestamp REAL`,
  `token_count`, `finish_reason`, `reasoning*` columns,
  `platform_message_id`, `observed INTEGER`, `active INTEGER DEFAULT 1`.
  Plus FTS5 mirrors (`messages_fts`, `messages_fts_trigram`) maintained by
  triggers — read the base table, ignore FTS.

Extraction:

- **Roles**: live data shows `user` (18,575 rows), `assistant` (42,391),
  `tool` (29,012), and rare `session_meta` (2). `user` = human/orchestrator
  input; `assistant` = Hermes; `tool` = tool results (`tool_name` set).
  `session_meta` is a gateway-written first-turn metadata row (tools/model/
  platform, `gateway/run.py:8795-8807`) that Hermes's own readers skip
  (`gateway/run.py:731`) — Argus should skip it too, and tolerate unknown
  roles.
- **Content**: usually a plain string. Multimodal content is stored as a
  sentinel-prefixed JSON string — prefix `"\x00json:"`
  (`hermes_state.py:2228-2249`); strip the prefix and `json.loads` when
  present. Multimodal tool results are reduced to text summaries before
  persisting (images never land in the DB, `run_agent.py:1565-1580`).
  `tool_calls` is a JSON array (`[{name, arguments}]`).
- **Timestamps**: `messages.timestamp` is set to `time.time()` **at INSERT**
  (`hermes_state.py:2332`), i.e. DB-write time ≈ utterance time in normal
  incremental operation, but **rewritten** wholesale by transcript-rewrite
  flows (below). Hermes itself orders by `id`, not timestamp: "Ordered by
  AUTOINCREMENT id (true insertion order) rather than timestamp"
  (`hermes_state.py:2453-2461`). Argus must do the same.
- **Rewrite hazards** a tailer must survive:
  - `/retry`, `/undo`, `/compress` call `replace_messages()` — delete +
    reinsert every row for the session in one transaction, with fresh
    autoincrement ids and a shared `now_ts` (`hermes_state.py:2363-2400`).
    The re-inserted history appears as "new" rows with one timestamp (this
    exact signature is visible in the live DB on an old CLI session).
    Dedup key: `(session_id, role, content-hash, position)`.
  - `/rewind` soft-deletes: sets `active = 0`, never deletes
    (`hermes_state.py:2872-2960`). Filter `active = 1` to mirror what the
    agent sees; keep inactive rows if the archive wants full history.
  - **Compression rotates the session id**: the old session gets
    `end_reason = 'compression'` and a NEW session row is created with
    `parent_session_id` pointing at it (lock machinery + rationale at
    `hermes_state.py:1249-1270`; live data shows chains like one titled
    session running through `#7 … #12`, each child parented to the last).
    A "logical session" for Argus purposes is the `parent_session_id`
    chain, not a single row. `end_session()` is first-reason-wins
    (`hermes_state.py:1210-1224`).
- **Session identity**: generated at agent init as
  `strftime("%Y%m%d_%H%M%S") + "_" + uuid4().hex[:6]`
  (`agent/agent_init.py:1015-1017`) unless a caller provides one (cron uses
  `cron_{job_id}_{ts}`, `cron/scheduler.py:1486`). The id is exported to the
  session's own tools via `HERMES_SESSION_ID` / a ContextVar
  (`agent/agent_init.py:1019-1027`) and **printed on exit even in quiet
  mode** — runtime-verified: `hermes chat -q … -Q` ended with
  `session_id: 20260824_142731_7b396a`. `sessions.cwd` is populated
  (`update_session_cwd`, `hermes_state.py:1241-1249`; runtime-verified — the
  scratch session recorded its cwd).

## 3. Profile-home behavior

- `HERMES_HOME` relocates everything, re-resolved dynamically
  (`hermes_constants.py:53-75`; full mechanics in the #10 note,
  `docs/research/hermes-memory-binding.md`). Runtime-verified here for the
  session stores: a scratch `HERMES_HOME` was bootstrapped on first run with
  its own `sessions/`, `state.db` (full schema), `memories/`, `logs/`,
  `cron/`, and the test session + message landed in the **scratch**
  `state.db`, not the global one.
- So under Argus's launch mode (`HERMES_HOME=~/.hermes/profiles/argus-<slug>`,
  per #10): transcripts are at
  `~/.hermes/profiles/argus-<slug>/state.db`, debug dumps at
  `~/.hermes/profiles/argus-<slug>/sessions/`. No `~/.hermes/profiles/`
  directory exists yet on this machine (nothing has created a profile).
- Caveat: `DEFAULT_DB_PATH` is computed at module import
  (`hermes_state.py:34`), so `HERMES_HOME` must be in the environment before
  the process starts — true for Argus's spawn-with-env model (and the `-p`
  flag pre-parses before imports, `hermes_cli/main.py:454`, per #10).
- Hermes explicitly blesses cross-process read-only polling of a live DB:
  `SessionDB(read_only=True)` opens `file:…?mode=ro` with "NO write lock, so
  polling another profile's live DB … never contends with that profile's
  running backend" (`hermes_state.py:606-633`). WAL journaling is applied at
  init (`hermes_state.py:157-206`, `651`).

## 4. The tailing recipe (implementable)

Per Argus-managed profile home `P = ~/.hermes/profiles/argus-<slug>`:

1. **Watch** `P/state.db` by polling a read-only sqlite connection
   (`file:P/state.db?mode=ro&immutable=0`, WAL-safe; 1-2 s interval is in
   line with Hermes's own sidebar polling). Optional wake-up optimization:
   FSEvents on `P/state.db-wal` mtime → poll now. Do **not** watch
   `P/sessions/` for transcripts — only `request_dump_*.json` error
   breadcrumbs appear there (useful as a crash/API-failure signal, nothing
   more).
2. **Cursor**: single integer per DB — `last_seen = max(messages.id)`.
   Fetch `SELECT * FROM messages WHERE id > :last_seen ORDER BY id`.
   AUTOINCREMENT guarantees monotonic ids even across `replace_messages`
   rewrites (`hermes_state.py:2453-2461`).
3. **Per row**: role → side (`user` = inbound, `assistant` = Hermes,
   `tool` = tool output; skip `session_meta`); content → strip `"\x00json:"`
   prefix + `json.loads` when present, else plain string; timestamp →
   `messages.timestamp` (epoch float; trust it except when a whole session's
   rows share one value — that's a rewrite replay, see 4). Filter or flag
   `active = 0`.
4. **Rewrite handling**: keep per-session content hashes; when a
   `replace_messages` replay arrives (burst of rows for an already-seen
   session, uniform timestamp, `sessions.message_count` reset), dedupe
   against hashes and emit only genuinely new suffix messages.
5. **Session discovery/metadata**: on new `session_id`, read its `sessions`
   row for `source`, `model`, `started_at`, `cwd`, `title`,
   `parent_session_id`. Stitch `parent_session_id` chains
   (`end_reason = 'compression'`) into one logical session for digests.
6. **Registry mapping**: one profile home per Argus deployment makes this
   trivial — every session in `P/state.db` belongs to that deployment.
   Within the home, the orchestrator's live session is the newest
   `source='cli'` row whose `started_at` ≥ spawn time (and whose `cwd`
   matches the workspace). Belt-and-braces: the id is also printed at exit
   (`session_id: …`, even under `-Q`), and inside the session
   `HERMES_SESSION_ID` is in the tool environment. There is no CLI flag to
   *set* the id at launch; `--resume <id>` only reopens existing rows.

## 5. Event ingestion — what exists, gateway vs CLI mode

**Interactive CLI mode (what Argus deploys in cmux): no ingestion surface.**
`hermes` / `hermes chat` binds no port and no unix socket — the only inputs
are the terminal and, in TUI mode, a stdio JSON-RPC pipe between the TUI and
its private backend child (`tui_gateway/transport.py` `StdioTransport`;
`tui_gateway/server.py` imports it at :27-34). Nothing in the CLI path polls
a queue file, and the cron ticker does **not** run here (below). The only
way to put text into a running CLI session from outside is its terminal —
i.e. `cmux send`.

**Gateway mode is a separate resident process** (`hermes gateway run|start`,
`gateway/run.py`) — on this machine one is already running for the *global*
home (PID 860, `hermes gateway run --replace`, WhatsApp connected,
`~/.hermes/gateway_state.json`). Note: there is **no `gateway/web_server.py`**
as SPEC §6 implies; the only `web_server.py` is `hermes_cli/web_server.py`,
the local Web-UI dashboard (FastAPI on 127.0.0.1:9119,
`hermes_cli/web_server.py:1-10`) — a management UI, not an event channel.
The gateway process hosts every real ingestion surface:

1. **Webhook platform** (`gateway/platforms/webhook.py`): aiohttp server,
   default port 8644 (`:77`), `POST /webhooks/<name>`, HMAC signature
   required per route (`:22-27`); routes are static config
   (`platforms.webhook.extra.routes`) or dynamic via
   `hermes webhook subscribe <name> --prompt … --events …` persisted in
   `webhook_subscriptions.json` and mtime-reloaded (`:106-149`). Each POST
   renders the payload into a prompt template and dispatches a **new
   ephemeral agent session** `webhook:{route}:{delivery_id}`
   (`:581-625`), returning 202 immediately; `--deliver-only` skips the LLM.
   Help text calls this "event-driven agent activation" — it activates a
   fresh run in the gateway; it does **not** inject into an existing
   session.
2. **OpenAI-compatible API server platform**
   (`gateway/platforms/api_server.py`): aiohttp, default port 8642, auth via
   `API_SERVER_KEY` (`:27-28`, `:89`, `:742-744`). Exposes
   `POST /api/sessions/{session_id}/chat`, `/v1/chat/completions` with
   `X-Hermes-Session-Id` continuity, `/v1/runs` lifecycle + SSE events
   (`:4-30`). This *can* append a turn to any persisted session by id — but
   the turn executes in the gateway process against the DB history. A CLI
   session's in-memory history is flush-only (it never re-reads the DB
   mid-run), so injecting into a session concurrently driven by a live cmux
   CLI process would fork/race its transcript. Safe for headless
   Hermes-as-a-service; not for poking a live terminal session.
3. **Messaging platforms** (WhatsApp/Telegram/…): normal chat ingestion into
   per-channel gateway sessions — how Johan's global gateway is used today.
4. **Kanban watchers** (`gateway/kanban_watchers.py`): background loops in
   the gateway poll kanban board DBs — notifier every 5 s over
   `task_events` with a stored cursor (`:29-60`), plus an embedded
   multi-agent dispatcher tick (`:559-616`). This is a real db-queue
   ingestion path, but again gateway-hosted.
5. **Cron**: ticker thread runs **inside the gateway process**
   (`gateway/run.py:15644`, started at `:16136`, 60 s interval; docstring:
   "Runs inside the gateway process so cronjobs fire automatically without
   needing a separate `hermes cron daemon`"). Without a gateway,
   `hermes cron tick` "runs due jobs once and exits" (CLI help) — an
   externally triggerable, zero-resident activation primitive.

**Not ingestion:** `hermes send` is outbound-only ("Pipe text from any shell
script to any messaging platform Hermes is already configured for … no LLM,
no agent loop", help text) — useful for Argus *notifications to Johan*, not
for feeding Hermes.

## 6. Verdict + recommended push path for SPEC §6

**Verdict: as written, "ping Hermes' gateway" does not work for the Hermes
that Argus actually deploys.** The gateway is a separate process; an
interactive cmux CLI session exposes no HTTP/socket/file ingestion at all.
The "Hermes push-channel fallback" fog patch should graduate to:

- **v1 (recommended): `cmux send` + event file.** Completion/blocked hooks
  keep writing `.argus/events/` (durable record, poll safety net per §6) and
  additionally `cmux send` a one-line event notification into Hermes'
  mission-control terminal. This is push, works today, needs zero new
  resident processes, and reuses cmux machinery the spec already mandates.
  Provenance note: these sends are *Argus*-authored user-side messages in
  Hermes' own transcript — log them in the registry (same discipline as
  Hermes-authored sends in §5) so watchers never misread them as
  Johan-authored.
- **Graduation path: profile gateway + webhook.** If/when the orchestrator
  moves from an interactive terminal to a resident service, run
  `hermes gateway` under the orchestrator's profile home with the webhook
  platform enabled; hooks then `POST http://127.0.0.1:8644/webhooks/argus-events`
  (HMAC-signed, `hermes webhook subscribe argus-events --prompt …`). Each
  event activates a fresh gateway-session run of Hermes with the event
  payload — the architecture Hermes itself intends for machine events. The
  api_server (`:8642`) is the alternative when Argus wants request/response
  semantics (`/v1/runs` + SSE) instead of fire-and-forget.
- **Not recommended:** api_server chat-injection into the live CLI session
  (transcript race, §5.2 above); messaging-platform detours; kanban
  dispatch (its own workflow model, and gateway-hosted anyway).

## 7. Open questions / caveats

- **Scratch-run scope**: the runtime check exercised session-row +
  first-user-message persistence (provider call failed 401 by design — the
  #10 auth-fallback rule means a non-profile scratch home has no
  credentials). Assistant/tool-row persistence rests on the code path
  evidence in §1-§2 plus live-DB observation of the global install, not on
  a scratch end-to-end turn. Confidence is high (same `append_message`
  path), but the first integration test should tail a real profile session.
- **`observed` column**: set for platform-mirrored messages Hermes saw but
  did not author (`gateway/mirror.py:159`); 0 everywhere in CLI data.
  Irrelevant for profile-scoped CLI tailing, worth keeping in the record
  schema.
- **Version drift**: all citations are hermes 0.16.0 as installed. The
  `messages`/`sessions` schema carries explicit migration machinery
  (`hermes_state.py:1126` v12 `active` flag, `repair_state_db_schema`), so
  pin the tailer's expectations to table+column presence, not schema
  version.
- **Gateway coexistence**: the global gateway (PID 860) tails the *global*
  home only; it will never see Argus profile homes. Conversely, if Argus
  ever starts per-profile gateways, `hermes gateway list` enumerates
  per-profile gateway status.
