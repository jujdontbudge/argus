# Honcho API fit for the per-repo peer model (ticket #13)

**Question:** does the self-hosted Honcho v3 API (deployed by ticket #3 at
`http://localhost:8000`) support SPEC §5.3 as specced — workspace per repo, Johan as
the observed user peer, each agent (claude-code, codex, hermes) as its own AI peer,
per-message peer attribution driven by Argus's provenance classification?

**Verdict: FIT with one deployment blocker.** The API shape matches §5.3 exactly —
every assumption verified empirically with real calls on 2026-08-24. The blocker is
not an API mismatch: the deriver's configured LLM (`z-ai/glm-4.7-flash` via
OpenRouter) cannot satisfy Honcho's `json_schema` structured-output parsing, so
representation derivation errors out 100% of the time as currently deployed. A
one-line config fix exists (below). The dialectic endpoint works today regardless.

All evidence: live curl calls against `http://localhost:8000` (admin JWT from
`~/.hermes/.env`, redacted), source truth from the `~/honcho` checkout (upstream
plastic-labs/honcho @ da4b3ee). Scratch artifacts were named `scratch-*` and deleted
afterwards.

---

## Workspace semantics

`POST /v3/workspaces` is **get_or_create**, idempotent, keyed by caller-chosen `id`
(server field `name`, ≤512 chars, `RESOURCE_NAME_PATTERN`); body takes `metadata`
(dict) and `configuration`. Returns **201** on create, **200** on the second identical
call with the same resource (`~/honcho/src/routers/workspaces.py:36-68`).

Verified live: first call 201, second call 200, identical `created_at`
(`2026-08-24T21:25:46Z`). Safe for the watcher to call unconditionally on startup —
no need for a get-then-create dance.

- List: `POST /v3/workspaces/list` (admin key required), paginated — default page
  size 50, cap 100. Argus code must paginate (also noted in ticket #3).
- Update: `PUT /v3/workspaces/{id}` (metadata/configuration).
- Delete: `DELETE /v3/workspaces/{id}` → **202**, asynchronous background deletion of
  all peers/sessions/messages/conclusions; returns **409 Conflict** while the
  workspace has active sessions — delete sessions first
  (`src/routers/workspaces.py:115-145`).

## Peer model — how "observed user" vs "AI peer" actually works

`POST /v3/workspaces/{ws}/peers` is get_or_create (201/200, same pattern), body
`{"id": ..., "metadata": ..., "configuration": ...}`. Verified live: all four scratch
peers created with 201 (`src/routers/peers.py:116`).

There is **no peer "type"** (no user-vs-AI flag). The distinction §5.3 needs is made
by two mechanisms, both verified in source:

1. **Authorship**: every message names its authoring peer (next section). The
   deriver groups representation work by *observed* peer — work-unit keys are
   `representation:{workspace}:{session}:{observed_peer}` (seen live in deriver
   logs), and derived conclusions carry `observed_id`. Johan's representation is
   built **only** from messages authored by Johan's peer id. This is the
   contamination guarantee, and it is structural, not prompt-level.
2. **Observation flags**: `observe_me` (peer-level and session-peer-level; session
   overrides peer; default **true**) controls whether Honcho builds a representation
   *of* that peer at all. `observe_others` (session-peer-level, default **false**)
   controls whether a peer builds local theory-of-mind representations of the other
   session peers (`src/schemas/configuration.py:211-224`,
   `src/deriver/enqueue.py:256-290,368`).

For §5.3 that means: Johan = a peer with `observe_me: true` (default); agents =
peers that exist primarily as message authors. Setting `observe_me: false` on agent
peers is an optional cost optimization (skips building representations *of* the
agents — saves deriver LLM calls); leaving it on is harmless and keeps agent
representations queryable. Both configurations were exercised live and accepted.

No dedicated peer-delete route exists — peers are removed by workspace deletion.

## Session + per-message attribution (the §5.3 core assumption)

`POST /v3/workspaces/{ws}/sessions` is get_or_create; body takes `id`, optional
`peers` map of `peer_id → {observe_me, observe_others}` (`SessionPeerConfig`),
optional `metadata`/`configuration` (`src/schemas/api.py:427-455`). Verified live:
201 with a 4-peer map including per-peer observation flags.

**Message ingest takes an authored-by peer id per message — exactly as §5.3
assumes.** `POST /v3/workspaces/{ws}/sessions/{sess}/messages` with body
`{"messages": [{"peer_id": ..., "content": ..., "metadata": ...}, ...]}` — batch of
1–100 (`MessageBatchCreate`, `src/schemas/api.py:349-404`). Verified live: a 5-message
batch alternating `scratch-johan` / `scratch-claude-code` / `scratch-codex` authors
returned 201 with each message echoing its `peer_id` and custom metadata
(`{"provenance": "johan-authored"}` etc. round-tripped intact — the watcher can stamp
its provenance classification into message metadata for audit). Peers named in
messages are auto-created if missing (message ingest is itself a get_or_create path
for peers), so strictly the watcher's "peers ensure" step is optional — but doing it
explicitly is still right, to set metadata/config.

Messages have update (metadata only, `PUT .../messages/{id}`) but no delete; they are
removed with their session/workspace.

## Deriver verdict: runs, claims, calls out — **fails on the configured model**

The full local pipeline was observed working except the final LLM parse:

- **Enqueue + batching**: ingest enqueued work units immediately. Representation
  units are gated: claimed only once a unit accumulates ≥512 tokens
  (`REPRESENTATION_BATCH_WORK_UNIT_TARGET_TOKENS`, default 512) **or** its oldest
  item is >30 min old (`REPRESENTATION_BATCH_MAX_AGE_SECONDS`, default 1800)
  (`src/config.py:954-971`, `src/deriver/queue_manager.py:330-445`). The first small
  batch (~135 tokens) sat pending for 5+ minutes by design; pushing units past 512
  tokens triggered claiming within seconds. **Watcher consequence: low-traffic
  repos see up to 30 min of deriver latency; that is normal, not a hang.**
- **Queue observability**: `GET /v3/workspaces/{ws}/queue/status` (optional
  `session_id`/`observer_id`/`sender_id` filters) returns
  pending/in_progress/completed work-unit counts. Verified live throughout.
- **Processing**: the deriver container claimed the units and made real OpenRouter
  calls on Johan's key. **Every call failed**: 12 LLM attempts, 6 batch-level
  errors, 0 successes. First attempts fail schema validation (the model returned a
  markdown bullet list — visibly containing correctly extracted facts — instead of
  JSON); retries return "No parsed content in structured response"
  (honcho-deriver-1 logs, 21:33–21:35Z). Net: `POST .../peers/{id}/representation`
  returns `{"representation": ""}`.

**Root cause + fix** (belongs to the deployment, out of scope for this ticket's
constraints): `z-ai/glm-4.7-flash` via OpenRouter does not honor OpenAI-style
`json_schema` structured outputs. Honcho ships a knob for exactly this:
`structured_output_mode: "json_object"` on the openai transport injects the schema
into the prompt instead (`src/config.py:71-73,186-200`). Either set
`DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE=json_object` in `~/honcho/.env` (and
verify GLM then parses; the summary/dream model routes may need the same), or switch
the deriver route to a model with native structured-output support. Until then §5.3's
"Deriver … maintains peer representations" is **not operational**.

## Dialectic works today (and the contamination picture)

`POST /v3/workspaces/{ws}/peers/{peer_id}/chat` (body `{"query": ...}`, optional
`stream`/`target`/`session_id`) worked live despite the broken deriver: a 37s agentic
run (9 tool calls — `search_memory`, `search_messages_temporal`, `grep_messages`;
~35k input tokens, honcho-api-1 logs) answered "what do you know about this user?"
for `scratch-johan` with an accurate, well-organized fact sheet drawn from raw
messages (Metro on 8082, iPhone 17 Pro + iPad mini, 1Password/no .env, bun/uv,
Stockholm/Fly ams, …).

- **Attribution probe (pass)**: agent-authored decoy facts ("I prefer yarn…my
  favorite editor is Emacs" from scratch-claude-code) did **not** leak into Johan's
  answer — it correctly reported bun and Cursor/Xcode.
- **Fidelity caveat**: querying the *agent* peer's chat conflated Johan-authored
  messages as "you also stated…". With the deriver down, dialectic falls back to raw
  message search across the session, and author separation then depends on the LLM's
  care, not on structure. The structural guarantee lives in the deriver's
  conclusion store (keyed by `observed_id`) — one more reason the deriver fix
  matters. §5.3's "semantic model of Johan is never contaminated" holds at the data
  model level; freeform dialectic answers are as good as the configured model.

## Scoping / isolation

- The admin JWT (`ad: true`) sees and does everything across workspaces — verified
  (`POST /v3/workspaces/list` returned both scratch workspaces). Fine locally.
- JWTs can be **workspace-, peer-, or session-scoped** (`JWTParams` fields
  `w`/`p`/`s`, `src/security.py:31-63`). Minted live via
  `POST /v3/keys?workspace_id=…` (admin-only route): the scoped key read its own
  workspace (200) and was refused cross-workspace (**401** "JWT not permissioned for
  this resource"). Peer/session-scoped keys must carry their parent workspace.
- Resources are fully workspace-scoped: `scratch-argus-verify-b`'s peer list was
  empty while workspace A had 4 peers — peer names do not bleed across workspaces.
- Watcher guidance: the admin key is fine for a single-user local deployment; if
  Argus ever hands keys to agents directly, mint per-workspace keys via `/v3/keys`.

## Managed vs self-hosted

Managed honcho.dev runs this same FastAPI server (per-org dedicated instance —
`~/honcho/README.md:18,59,73`). Everything §5.3 relies on — deriver, dialectic,
peers/sessions/messages, webhooks, dreamer, scopes, conclusions — is in the
self-hosted codebase; nothing API-level is managed-only. Managed adds the
app.honcho.dev dashboard, hosted key management, billing/credits, and operated LLM
keys (self-hosted brings its own, hence the GLM issue above). The spec's "a URL
change away" claim holds.

## Spec-vs-API mismatches

1. **"Honcho's Deriver runs its separate dialectic reasoning pass server-side and
   maintains peer representations"** (§5.3) — runs server-side: yes, verified; but
   *maintains representations*: *currently false in this deployment* (model config
   blocker above). Needs a follow-up deployment ticket before any Argus code trusts
   representations.
2. **Deriver latency**: §5.3 is silent on it; reality is up-to-30-min batching for
   low-volume ingest. Not a mismatch, but the watcher and any "why is Honcho empty"
   debugging must know it.
3. **No user-vs-AI peer type**: §5.3's "Johan as the observed user peer, each agent
   as its own AI peer" maps to plain peers + authorship + `observe_me`/
   `observe_others` flags. Semantically equivalent, verified working; just don't go
   looking for a `type` field.
4. Minor: create endpoints return the field as `id` in JSON but it's `name`
   server-side; workspace/session/peer ids are caller-chosen strings ≤512 chars.

## Watcher call sequence (implementable)

All calls: `Authorization: Bearer $HONCHO_API_KEY` (from `~/.hermes/.env` /
`~/.honcho/config.json`), `Content-Type: application/json`, base
`http://localhost:8000`. Every "ensure" is a real get_or_create — call it
unconditionally, treat 200 and 201 both as success.

```text
# 1. Workspace ensure (once per repo, at argus init / watcher start)
POST /v3/workspaces
{"id": "argus-<repo-name>", "metadata": {"repo": "<git remote or path>"}}
# 201 created | 200 existed

# 2. Peers ensure (idempotent; run after workspace ensure)
POST /v3/workspaces/argus-<repo>/peers        {"id": "johan"}
POST /v3/workspaces/argus-<repo>/peers        {"id": "claude-code", "configuration": {"observe_me": false}}
POST /v3/workspaces/argus-<repo>/peers        {"id": "codex",       "configuration": {"observe_me": false}}
POST /v3/workspaces/argus-<repo>/peers        {"id": "hermes",      "configuration": {"observe_me": false}}
# observe_me:false on agents = skip building representations OF agents (deriver-cost
# optimization; drop it if agent self-models are wanted). Johan defaults to observed.

# 3. Session ensure (one per Argus session, e.g. ticket-scoped id)
POST /v3/workspaces/argus-<repo>/sessions
{"id": "<ticket>-<session-id>",
 "peers": {"johan": {}, "claude-code": {}, "codex": {}, "hermes": {}},
 "metadata": {"agent": "<agent>", "ticket": "<n>"}}

# 4. Message ingest (per exchange; provenance classification decides peer_id;
#    batch up to 100 per call)
POST /v3/workspaces/argus-<repo>/sessions/<session>/messages
{"messages": [
  {"peer_id": "johan",       "content": "<johan-authored text>", "metadata": {"provenance": "johan"}},
  {"peer_id": "claude-code", "content": "<agent output>",        "metadata": {"provenance": "agent"}}
]}
# 201; response echoes per-message id/peer_id/token_count

# 5. Observability / reads
GET  /v3/workspaces/argus-<repo>/queue/status            # deriver progress
POST /v3/workspaces/argus-<repo>/peers/johan/representation   {}    # derived facts
POST /v3/workspaces/argus-<repo>/peers/johan/chat  {"query": "..."} # dialectic

# Deletion (available; all async 202)
DELETE /v3/workspaces/<ws>/sessions/<session>   # first — workspace delete 409s on active sessions
DELETE /v3/workspaces/<ws>                      # background-deletes peers/messages/conclusions
```

Pagination: all `/list` endpoints default to 50 per page, cap 100 — paginate in
`argus init`/watcher listings.

## Scratch cleanup

Deleted via API on 2026-08-24: session `scratch-session-1` (202), workspaces
`scratch-argus-verify` and `scratch-argus-verify-b` (202 each; deletion is
asynchronous/background). Peers and messages are removed by workspace deletion; no
standalone peer/message delete routes exist. One workspace-scoped JWT for
`scratch-argus-verify-b` was minted during the isolation test; JWTs are stateless and
irrevocable, but it only grants access to a deleted workspace, so it is inert.
