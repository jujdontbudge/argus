# Codex rollout → repo attribution

Research findings for ticket [#5](https://github.com/JohanSardar/argus/issues/5) (SPEC.md §2, §5, §7.3, §11.4).
Date: 2026-08-24. Question: Codex rollouts are date-filed
(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), not repo-filed — what is the reliable
rule for extracting cwd/repo from rollout content, for the shared transcript-tailing
library?

**Sources.** (a) The complete local archive on this machine: 1,302 rollout files,
2025-09-10 → 2026-08-24, ~50 distinct CLI versions 0.39.0 → 0.149.0 (installed:
`codex-cli 0.149.0`); every file's meta profiled, plus targeted full-file scans.
(b) The Codex CLI source, openai/codex at HEAD `0d9bb6c34c` (2026-08-24),
cross-checked against tag `rust-v0.149.0` (2026-08-20) — the two differ only in
unrelated `Op` additions, so citations apply to the installed binary; historical
claims verified against tag `rust-v0.30.0`. (c) Direct git experiments for worktree
resolution (§3).

---

## TL;DR — the extraction rule

1. **cwd** = `session_meta.cwd` from the file's first line (succeeds on **1,301/1,302**
   local files), overridden by any later `turn_context.cwd` (latest wins); pre-0.32
   flat-format files (1 local file) fall back to the `<cwd>` inside the
   `<environment_context>` user message.
2. **repo** = resolve cwd through git **immediately at tail time** (worktrees are
   deleted after merge): worktree cwds map to the parent repo via
   `git rev-parse --git-common-dir` or the `.git` file's `gitdir:` line minus
   `/worktrees/<name>`. Dead-path backfill falls back to `session_meta.git`
   (best-effort snapshot; present on all 109 observed worktree sessions, 848/1,302
   overall).

Full precise rule in §6.

---

## 1. Where cwd/repo appears in the JSONL

Every line in a modern rollout is a `RolloutLine` envelope:
`{"timestamp": "...", "ordinal": <u64, optional>, "type": "<snake_case>", "payload": {...}}`
(`codex-rs/history/src/lib.rs:201`; writer `codex-rs/rollout/src/recorder.rs:1949`).
`ordinal` appears only on paginated-mode rollouts (`codex-rs/rollout/src/ordinal.rs:18`).
Line types observed locally + in source (`codex-rs/history/src/rollout_payload.rs:22`):
`session_meta`, `response_item`, `turn_context`, `event_msg`, `compacted`,
`world_state`, `security_risk_score`, `inter_agent_communication`(`_metadata`).

The places cwd/repo appear, with local hit-rates:

### 1.1 `session_meta` (line 1) — the anchor: 1,301/1,302 files

Payload = `SessionMetaLine` = `SessionMeta` + optional `git`
(`codex-rs/protocol/src/protocol.rs:2884, 2975`). Attribution-relevant fields:

| Field | Since | Notes |
| --- | --- | --- |
| `id` | always | stable thread id (UUID); matches the filename |
| `cwd` | 0.32 | directory the session started in — present in every local envelope-era file |
| `originator` | 0.32 | client program; local values: `codex_exec` 513, `codex-tui` 345, **`Claude Code` 198** (Codex launched by the Claude Code plugin), `Codex Desktop` 141, `codex_cli_rs` 78, `codex_vscode` 22, `agentdeck` 4 |
| `cli_version` | 0.32 | per-file version — use to pick the parse era |
| `source` | 0.44 | string `cli`/`vscode`/`exec`/`mcp` or object `{"subagent": …}`/`{"internal": …}`; local: exec 418, vscode 215, cli 126, mcp 40, subagent 491+, absent 12 (old files). **Absent deserializes as `vscode`** — treat missing as unknown |
| `forked_from_id` | 0.88 | set on forked threads |
| `parent_thread_id` | 0.140 | set on sub-agent threads |
| `history_mode` | 0.143 | `legacy` (default) / `paginated`; 62 local paginated files, all 0.149 |
| `git` | mid-2025 | `{commit_hash?, branch?, repository_url?}` — session-start snapshot, **best-effort only** (§2) |

`session_meta` is written lazily — file creation defers to the first `persist()`
(`recorder.rs:817-899`) — so empty sessions may never produce a file, and 1-line
meta-only files exist locally.

### 1.2 `turn_context` — per-turn cwd: 1,293/1,302 files

`TurnContextItem` (`protocol.rs:3040`), persisted once per real user turn (and after
mid-turn compaction). `cwd` is **required**; `workspace_roots[]` appears ≥ ~0.14x.
Since a resumed-from-elsewhere session keeps its old meta but writes fresh turn
contexts, **the latest `turn_context.cwd` beats `session_meta.cwd`**. Locally, only
3/1,302 files show turn_context ≠ meta cwd (all deliberate 2026-06-05 experiments) —
drift is real but rare. Exists since 0.35 (2025-09-15).

### 1.3 `<environment_context>` — the pre-0.32 fallback: 1,295/1,302 files

Not a line type: a user-role `response_item` whose text embeds
`<environment_context>…<cwd>…</cwd>…</environment_context>`
(v0.30.0 `codex-rs/core/src/environment_context.rs`). In flat-era files it is the
**only** cwd source; the single local flat file's cwd is recoverable this way. In
modern files it appears once (first user message), not per turn.

### 1.4 Outside the rollout (not attribution sources)

- `~/.codex/state_5.sqlite` `threads` table (since 0.117): `id, rollout_path, source,
  cwd, git_sha, git_branch, git_origin_url, archived, …`
  (`codex-rs/state/migrations/0001_threads.sql`) — a **rebuildable projection** of
  the rollout files, never ahead of them (`thread-store/src/local/live_writer.rs:309-347`).
  Acceptable bootstrap catalog for backfill; wrong as the tailing source of truth.
- `~/.codex/thread_history_1.sqlite`: turns/items keyed by `thread_id` +
  `rollout_ordinal` + `rollout_byte_offset` — a byte-offset projection **over** the
  rollout files, no thread-level cwd column.
- `~/.codex/session_index.jsonl` (199 local entries): id → thread_name only.
  `~/.codex/history.jsonl`: `{session_id, text, ts}`. **Neither carries cwd.**

---

## 2. Format eras and stability across versions

Source-side timeline of attribution-relevant changes:

| Release (date) | Change |
| --- | --- |
| ≤ 0.31 | **Flat format**: line 1 `{"id","timestamp","instructions","git"?}` — no envelope, no cwd in meta; bare `ResponseItem` lines + `{"record_type":"state"}` |
| 0.32.0 (2025-09-10) | `RolloutLine` envelope; meta gains `cwd`, `originator`, `cli_version` |
| 0.35.0 (2025-09-15) | `turn_context` + `compacted` line types |
| 0.44.0 (2025-10-03) | `source` field |
| 0.88.0 (2026-01-21) | `forked_from_id`; `instructions` → structured `base_instructions` |
| 0.137.0 (2026-06-03) | background zstd compression: rollouts **older than 7 days** may become `<name>.jsonl.zst` (`codex-rs/rollout/src/compression.rs`) |
| 0.140.0 (2026-06-15) | `parent_thread_id`; `inter_agent_communication` |
| 0.143.0 (2026-07-07) | `history_mode` legacy/paginated, `history_base` |
| 0.145.0 (2026-07-21) | `ordinal` on lines (paginated only) |
| 0.148.0 (2026-08-18) | `codex migrate-rollouts`; `thread/revert` `_<rollout_id>` filename suffix |

Local archive reality (every file profiled):

| Era | Versions seen | Files | cwd location |
| --- | --- | --- | --- |
| Flat | pre-0.39 | 1 | env-context XML only |
| Envelope | 0.39.0 → 0.116 | ~35 | `session_meta.payload.cwd`, always |
| Envelope+git | 0.117.0 → 0.148 | ~1,200 | same, plus best-effort `git` block |
| Paginated | 0.149.0 | 62 | same; lines gain `ordinal`, meta gains `session_id`, `thread_source`, `context_window` |

**Stability verdict:** `session_meta.cwd` and `turn_context.cwd` have never moved or
been renamed across the entire envelope era (0.39 → 0.149, every originator and
source); all changes are additive. The one true schema break in the archive is the
flat pre-0.32 format (1 file).

**The git block is NOT reliable.** Among non-attributed-to-git files: 206 lack the
block entirely and 247 have it with `repository_url: null`. Absence is
version/cohort-correlated, not only "not a repo" — 0.137.0 lacked it in 70/87 files
including 9 sessions inside a real repo (`~/reform`); a 0.147-alpha Desktop cohort
lacked it in 35/36. It behaves like best-effort async collection that can time out
under load (parallel exec fleets are exactly the absent cohorts); `repository_url:
null` also occurs for repos without remotes. **Never require it; use it only as the
dead-path fallback.**

---

## 3. Worktree → parent repo mapping

Argus ticket sessions run in git worktrees (SPEC §7.3). The archive already holds
~120+ worktree sessions: `<repo>/.claude/worktrees/agent-*`,
`<repo>/.claude/codex-worktrees/*`, and out-of-tree lanes (`~/ExcerLock-lanes/c1`,
`~/reform-lane2/3`).

Mechanics, verified by direct experiment (2026-08-24):

- The worktree root's `.git` is a **file**: `gitdir: <parent>/.git/worktrees/<name>`.
  Strip the `/worktrees/<name>` suffix → parent git dir; its dirname → parent working
  tree. Pure file reads, no git invocation.
- Equivalent via git, from **any depth** inside the worktree:
  `git -C <cwd> rev-parse --path-format=absolute --git-common-dir` → `<parent>/.git`.
- Reverse map: `git -C <parent> worktree list --porcelain`.
- Bare parent caveat: the dirname of the common git dir is then not a working tree —
  keep the git-dir path as the repo identity.

**Critical edge from the archive:** `~/ExcerLock-lanes/c1` no longer exists — Argus
merges then deletes worktrees, so **filesystem resolution must happen at tail time,
live**, not deferred to backfill. When the path is gone, the only in-rollout parent
signal is the `git` snapshot: worktree sessions locally show either a local-path
`repository_url` (`"/Users/johansardar/reform"` — the parent checkout) or a remote URL
(`git@github.com:JohanSardar/excerlock-app.git`), plus `branch`. All 109
`.claude/*worktree*` sessions had a `repository_url`; still treat it as best-effort
(§2).

---

## 4. Session lifecycle edge cases

- **Resume appends to the same file — and may write extra `session_meta` lines.**
  At 0.149 the resume path opens with `append(true)` and writes no new meta
  (`RolloutRecorderParams::Resume`, `recorder.rs:900-912`), but empirically **389/1,302
  local files contain multiple `session_meta` lines with the *same* `id`** (one per
  resume; one 0.144 vscode file has 15). Same cwd in all observed cases; zero
  intra-file meta cwd conflicts archive-wide. Rule: a later meta with the same id is
  a resume marker — re-verify, don't re-attribute. A `.jsonl.zst` rollout is
  rematerialized to plain `.jsonl` before append (`recorder.rs:1896`).
- **Fork/backtrack creates a new file** with a new thread id and `forked_from_id` in
  its meta; parent history is *copied* in (`thread_manager.rs:1176`) — which is why
  **37+ local files carry a second `session_meta` with a *different* id**: line 1 =
  this file's session, later meta = the embedded parent's. Attribute by the FIRST
  meta; a different-id meta is parent linkage only. Paginated forks may instead
  *reference* the parent via `history_base {thread_id, end_ordinal_exclusive,
  end_byte_offset}` with no copied content (`protocol.rs:2864`) — never chase
  `history_base` for cwd.
- **`thread/revert`** keeps the thread id but starts a new file named
  `rollout-<ts>-<thread_id>_<rollout_id>.jsonl` (0.148+). Parse: split the id segment
  on `_`; absent `_`, thread id == rollout id (`rollout_file_name.rs`).
- **Queued messages** (`codex queue --thread <id>`) append to the existing thread's
  rollout — no new file, attribution unaffected.
- **Sub-agent sessions** (review, spawned agents, guardian, memory consolidation) are
  full sessions with their own rollout files — 491 locally, `source =
  {"subagent": {"thread_spawn": {parent_thread_id, depth, agent_nickname, agent_role}}}`
  and the like. They inherit the parent's cwd, so attribution works unchanged;
  `parent_thread_id` groups them under the parent's ticket session.
- **Compression:** any rollout older than 7 days may become `.jsonl.zst` (since
  0.137) and swap back to `.jsonl` on resume. Treat both suffixes as one logical
  file. (`find rollout-*.jsonl` locally returned 1,302 — a tailer must glob both.)
- **`codex migrate-rollouts`** (0.148+; report-only without `--apply`) rewrites legacy
  rollouts **in place at the same path** into paginated form (meta gains
  `history_mode: "paginated"`, lines gain `ordinal`), then projects into
  `thread_history_1.sqlite` and verifies. **Codex keeps writing rollout JSONL in the
  paginated era** — 0.149 files from today exist locally with `ordinal` fields;
  SQLite is a derived view (`live_writer.rs:309-347`). Same cwd fields; the tailer
  must survive an in-place rewrite (inode change) without new content. Default
  `history_mode` for new TUI/CLI threads at 0.149 is still `legacy` (`store.rs:76`).
- **Sessions outside any repo** are common and legitimate: cwd = `$HOME` (×8),
  `/private/tmp/*` scratch and exec-fleet dirs (60 in one test dir alone). They
  attribute to no repo; Argus watchers ignore them unless cwd is inside a watched
  repo.
- **Path canonicalization:** macOS mismatch observed — meta `/tmp/codextest` vs
  turn_context `/private/tmp/codextest`. Always `realpath` before comparing.
- **`cd` mid-session:** Codex has no persistent `cd` op — shell `cd` inside a command
  never moves the session cwd. cwd moves only via resume-from-elsewhere or
  client-supplied turn-context overrides, both surfacing as new `turn_context.cwd`
  values (3/1,302 locally, all deliberate tests).
- **Archived sessions:** `~/.codex/archived_sessions/` holds moved rollout files in
  identical format — watch it too, and treat moves as renames of the same thread.
- **Empty/tiny files:** 1-line (meta-only) files exist; zero unparseable files in
  the archive.

---

## 5. Recommended extraction rule (implementable)

Scope: one rule per rollout file, streaming (tail) or backfill. Field paths are
against the `RolloutLine` envelope.

```
attribute(file):
  thread_id, rollout_id = parse_filename(file)   # rollout-<ts>-<tid>[_<rid>].jsonl[.zst]
  cwd = None; git_snapshot = None; meta = None

  for line in lines(file):                       # transparently decompress .zst
    if line has "type":                          # envelope era (0.32+)
      switch line.type:
        "session_meta":
          if meta is None:                       # FIRST meta wins
            meta = line.payload
            cwd = realpath(meta.cwd)
            git_snapshot = meta.git              # may be null — never require it
          elif line.payload.id == meta.id:       # resume marker
            assert_same_or_flag(realpath(line.payload.cwd), cwd)
          else:                                  # embedded parent meta (fork/copy)
            record_parent_link(line.payload.id)
        "turn_context":
          new = realpath(line.payload.cwd)       # ALWAYS overrides: latest wins
          if new != cwd: cwd = new; re_attribute()
        "response_item":
          if cwd is None:                        # pre-0.32 fallback only
            cwd = parse_environment_context_cwd(line.payload)
    else:                                        # flat era (1 file in archive)
      if first line: git_snapshot = line.git
      cwd ||= parse_environment_context_cwd(line)

  repo = resolve_repo(cwd, git_snapshot)         # AT TAIL TIME — do not defer

resolve_repo(cwd, git_snapshot):
  if cwd exists:
    root = walk up from cwd to nearest ".git" entry
    if none: return NO_REPO                      # $HOME / scratch sessions — real
    if root/.git is a file:                      # worktree
      parent_git = gitdir_value.strip_suffix("/worktrees/<name>")
      return dirname(parent_git)                 # bare parent: return parent_git
    return root                                  # normal repo
  else:                                          # deleted worktree / backfill
    return by git_snapshot.repository_url        # local path = parent checkout,
           + git_snapshot.branch                 # or remote URL; may be absent →
                                                 # unattributed bucket
```

Operational notes for the tailing library:

1. **Resolve at tail time.** Worktrees are deleted after merge (observed in the
   archive); cache `cwd → repo` at first sight of the session, not at backfill.
2. **Latest `turn_context` wins** — re-evaluate on every `turn_context` line. Rare
   (3/1,302) but it is exactly the resume-from-elsewhere failure mode.
3. **Multiple `session_meta` lines are normal** (389/1,302 files): same id = resume,
   different id = embedded parent meta. First meta owns attribution.
4. **`realpath` everything** before comparing (`/tmp` vs `/private/tmp`).
5. **Identity & grouping:** thread id from the filename (`_` suffix rule for revert
   files); `forked_from_id`/`parent_thread_id`/embedded parent metas link forks and
   sub-agent sessions — group sub-agents under the parent's ticket.
6. **Watch semantics:** glob `*.jsonl` **and** `*.jsonl.zst`; treat the suffix swap
   as the same file; reopen on inode change (`migrate-rollouts` rewrites in place);
   resumes append to old date-dirs, so tail the whole tree, not just today; also
   watch `~/.codex/archived_sessions/`.
7. **Do not** attribute from `history.jsonl`, `session_index.jsonl`, or the sqlite
   DBs (no cwd, or derived views). `state_5.sqlite#threads` (id → cwd, rollout_path,
   git_*) is an acceptable *bootstrap catalog* for backfill only.
8. **Ignore unknown line types and fields** — the format grows additively (§2);
   `ordinal` and `world_state` already demonstrate it.

---

## Appendix: source citations

openai/codex @ `0d9bb6c34c` (≈ `rust-v0.149.0`): envelope `history/src/lib.rs:201`;
writer `rollout/src/recorder.rs:817-1949`; meta types `protocol/src/protocol.rs:2884,
2975, 3040, 3166`; path naming `rollout/src/recorder.rs:1607-1629`,
`rollout/src/rollout_file_name.rs`; persistence policy `rollout/src/policy.rs`;
compression `rollout/src/compression.rs`; fork `core/src/thread_manager.rs:1176,
1249+`; migration `cli/src/migrate_rollouts.rs`,
`thread-store/src/local/rollout_migration.rs`, `thread-store/src/local/live_writer.rs:309-347`;
sqlite schemas `state/migrations/0001_threads.sql`,
`state/thread_history_migrations/0001_thread_history.sql`; originator resolution
`login/src/auth/default_client.rs:40-84`. Flat-era format read at `rust-v0.30.0`.
Local archive: `~/.codex/sessions/**` (1,302 files), `~/.codex/state_5.sqlite`,
`~/.codex/thread_history_1.sqlite`, `~/.codex/session_index.jsonl`, examined
read-only 2026-08-24.
