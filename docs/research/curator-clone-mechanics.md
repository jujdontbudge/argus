# Hermes native curator mechanics (for the Argus curator clone)

Researched on 2026-08-24 for Argus issue #16. Sources: the installed Hermes
source tree (`~/.hermes/hermes-agent/`, `hermes` v0.16.0 — all `file:line`
citations refer to files under that root), the live install at `~/.hermes/`
(read-only reads of `skills/.curator_state`, `skills/.usage.json`,
`skills/.archive/`, `logs/curator/`), and one runtime check with the install's
own venv under a scratch `HERMES_HOME` in the session scratchpad. Nothing
under `~/.hermes` was modified; no processes were left running. Builds on the
#10 note (`docs/research/hermes-memory-binding.md`, branch
`research/hermes-memory-binding`) and the #12 note
(`docs/research/hermes-internals.md`, branch `research/hermes-internals`).

**TL;DR for the spec:** SPEC §5.1's "cloned from Hermes' native curator: stale
after 30 days, archive after 90" is accurate about the numbers but wrong about
the scope. The native curator is **skills-only**. It never reads or writes
`MEMORY.md`/`USER.md` — its LLM fork is constructed with `skip_memory=True`
and memory nudges disabled (`agent/curator.py:1760,1762-1764`), and nothing
else in `agent/curator.py` references memory. The "dedupes/compacts the memory
files" half of the Argus curator pass has **no native counterpart to clone**;
it must be specified fresh (§6 below). The skills half, by contrast, is richly
implemented and much of it lifts cleanly.

## 1. Where it is implemented

The curator is a first-class Hermes feature spread over five modules:

- **`agent/curator.py`** (1835 lines) — the orchestrator: scheduling gates,
  the deterministic stale/archive state machine, the LLM review prompt, the
  forked review agent, per-run reports. Module docstring at
  `agent/curator.py:1-20`: "background skill maintenance orchestrator …
  runs inactivity-triggered (no cron daemon)".
- **`tools/skill_usage.py`** (887 lines) — per-skill usage telemetry and
  lifecycle state in a sidecar `~/.hermes/skills/.usage.json`
  (`tools/skill_usage.py:1-23,85-87`), plus `archive_skill`/`restore_skill`
  and the candidate-enumeration/provenance filters.
- **`tools/skill_provenance.py`** — write-origin ContextVar so only skills the
  agent autonomously created are auto-curated; "Skills a user asks a
  foreground agent to write belong to the user and must never be auto-curated"
  (`tools/skill_provenance.py:3-5`).
- **`agent/curator_backup.py`** — pre-run tar.gz snapshots of the skills tree
  under `skills/.curator_backups/<utc-iso>/` (`agent/curator_backup.py:3-5,71`),
  pruned to `backup.keep` (default 5, `agent/curator_backup.py:164-167,279`).
- **`hermes_cli/curator.py`** — the `hermes curator` CLI:
  `status | run [--dry-run] [--background] | pause | resume | pin | unpin |
  archive | restore | list-archived | rollback`
  (`hermes_cli/curator.py:489-576`). There is also an in-chat `/curator`
  command (`cli.py:7420-7421`) and a dashboard panel
  (`hermes_cli/web_server.py:1788-1810`).

Config lives in the `curator:` block, defaults at `hermes_cli/config.py:1852-1884`:
`enabled: true`, `interval_hours: 168` (7 days), `min_idle_hours: 2`,
`stale_after_days: 30`, `archive_after_days: 90`, `prune_builtins: true`,
`backup: {enabled: true, keep: 5}`. The same constants are hard-coded as
fallbacks at `agent/curator.py:55-58`. **This is where SPEC §5.1's 30/90
numbers come from** — they are the skill-staleness thresholds
(`stale_after_days`/`archive_after_days`), nothing to do with memory.

## 2. Scheduling / trigger

There is no cron job and no daemon. `maybe_run_curator()`
(`agent/curator.py:1817-1835`) is called opportunistically and gates itself:

- **Static gates** in `should_run_now()` (`agent/curator.py:198-252`):
  `curator.enabled`, not paused, and `now - last_run_at >= interval_hours`.
  State lives in `~/.hermes/skills/.curator_state`
  (`agent/curator.py:66-67`): `last_run_at`, `last_run_summary`,
  `last_report_path`, `paused`, `run_count`.
- **First-run behavior**: a home with no `last_run_at` does *not* run; the
  curator seeds `last_run_at = now` and defers one full interval
  (`agent/curator.py:222-241`). Runtime-verified under a scratch
  `HERMES_HOME`: `should_run_now()` returned `False` and wrote the
  "deferred first run" state.
- **Idle gate**: `min_idle_hours` is enforced only when the caller measures
  idleness (`agent/curator.py:1826-1830`); both production call sites pass
  `idle_for_seconds=float("inf")`.

Two production trigger sites:

1. **Interactive CLI session startup** — `hermes`/`hermes chat` kicks off
   `maybe_run_curator(idle_for_seconds=inf)` in a daemon thread right after
   the welcome banner (`cli.py:10868-10881`). So the curator *does* run in
   Argus's deployment mode (interactive CLI, no gateway) — at most once per
   7 days, on session start, per home.
2. **Gateway cron ticker** — long-running gateways poll it hourly
   (`CURATOR_EVERY = 60` ticks, `gateway/run.py:15665`; call at
   `gateway/run.py:15725-15733`), same internal 7-day gate.

Manual: `hermes curator run` (bypasses all gates; `--dry-run` = report-only
pass that neither mutates skills nor bumps `last_run_at`,
`agent/curator.py:1444-1451,1478-1483`; `hermes_cli/curator.py:168-215`).

## 3. What it scans

**Skills only, and only under `get_hermes_home()/skills/`.**

- Candidate enumeration (`tools/skill_usage.list_agent_created_skill_names`,
  `tools/skill_usage.py:330-380`): `rglob("SKILL.md")` under
  `get_hermes_home()/skills` (`_skills_dir()`, `tools/skill_usage.py:81-82`),
  skipping `EXCLUDED_SKILL_DIRS` (`.git`, `.hub`, `.archive`, venvs, caches —
  `agent/skill_utils.py:27-44`). The skill's identity is the frontmatter
  `name:` (`tools/skill_usage.py:394-413`).
- Eligibility filter (`is_curation_eligible`, `tools/skill_usage.py:431-447`):
  hub-installed skills **never** (external upstream owner); the protected
  built-in set (currently just `plan`) **never**
  (`tools/skill_usage.py:58-79`); bundled built-ins only when
  `curator.prune_builtins` is on (default on) — and then their inactivity
  clock is seeded on first sight so they are never mass-pruned
  (`agent/curator.py:264-268,283-289`); everything else must carry an
  agent-created usage record (`created_by == "agent"`,
  `tools/skill_usage.py:449-456`), set when `skill_manage(action="create")`
  runs inside the background-review fork
  (`tools/skill_manager_tool.py:972-978`, `tools/skill_provenance.py:3-15`).
- Telemetry it judges from: the sidecar
  `~/.hermes/skills/.usage.json`, per-skill records
  `{created_by, use_count, view_count, patch_count, last_used_at,
  last_viewed_at, last_patched_at, created_at, state, pinned, archived_at}`
  (`_empty_record`, `tools/skill_usage.py:460-474`). Counters are bumped by
  Hermes's own tools: `skill_view` counts as both view **and** use
  ("Curator's stale timer keys off last_used_at",
  `tools/skills_tool.py:1594-1599`), `skill_manage` bumps patches
  (`tools/skill_manager_tool.py:972-978`), slash-command/bundle activation
  bumps use (`agent/skill_commands.py:460-461`, `agent/skill_bundles.py:299-300`).

**Checked, absent:** the curator does not scan memory files, `state.db`,
sessions, or `skills.external_dirs`. `agent/curator.py` and
`tools/skill_usage.py` contain no reference to `get_external_skills_dirs`
(grep over both files); both the enumerator and `_find_skill_dir`
(`tools/skill_usage.py:789-804`) walk only `get_hermes_home()/skills`. A
skill living in an external dir is invisible to the curator, and
`archive_skill` could not move it even if named.

Skill entries are **not** timestamped in the SKILL.md itself; all 30/90-day
judgments come from the sidecar's activity timestamps.

## 4. The pass itself — two phases

`run_curator_review()` (`agent/curator.py:1407-1609`) runs, in order:

**Phase 0 — backup.** Snapshot `skills/` to
`skills/.curator_backups/<utc-iso>/skills.tar.gz` (skipped on dry-run;
best-effort — a failed snapshot never blocks the run,
`agent/curator.py:1452-1462`; `hermes curator rollback` restores,
`hermes_cli/curator.py:391-460`).

**Phase 1 — deterministic auto-transitions (pure function, no LLM).**
`apply_automatic_transitions()` (`agent/curator.py:255-311`):

- Anchor per skill = newest of `last_used_at`/`last_viewed_at`/`last_patched_at`
  (`latest_activity_at`, `tools/skill_usage.py:146-164`), falling back to
  `created_at` so new skills don't immediately archive
  (`agent/curator.py:293-296`).
- `anchor <= now − archive_after_days` → `archive_skill()`: the skill's whole
  directory is **moved** (rename, shutil.move cross-device) to
  `skills/.archive/<name>/`, flattened, timestamp-suffixed on collision;
  state set to `archived`; a pruned built-in is added to
  `skills/.curator_suppressed` so `hermes update`'s re-seeder leaves it
  archived (`tools/skill_usage.py:672-725,263-328`). **Never deleted** —
  "Archive is recoverable" is a module invariant (`agent/curator.py:16-17`).
- `anchor <= now − stale_after_days` and currently active → state = `stale`.
- Activity newer than the stale cutoff on a stale skill → reactivated.
- `pinned` skills are skipped entirely; unrecorded-but-eligible skills are
  seeded and deferred (`agent/curator.py:279-289`).

**Phase 2 — LLM consolidation pass (forked agent).** If any candidates exist,
`_run_llm_review()` (`agent/curator.py:1676-1815`) spawns a fresh in-process
`AIAgent` with `platform="curator"`, `max_iterations=9999`, `quiet_mode=True`,
`skip_context_files=True`, `skip_memory=True`, and both self-review nudges
zeroed (`agent/curator.py:1744-1764`). Model: the `auxiliary.curator`
task slot; default "auto" = **the main chat model**
(`agent/curator.py:1657-1674`). The prompt is `CURATOR_REVIEW_PROMPT`
(`agent/curator.py:344-486`) plus a rendered candidate list with usage stats
(`_render_candidate_list`, `agent/curator.py:1387-1404`). The prompt's key
content, near-verbatim:

- Framing: "an UMBRELLA-BUILDING consolidation pass, not a passive audit and
  not a duplicate-finder"; the target is "CLASS-LEVEL skills with rich
  SKILL.md bodies + `references/`, `templates/`, and `scripts/` subfiles",
  because "one broad umbrella skill with labeled subsections beats five
  narrow siblings for discoverability".
- Hard rules: never touch bundled/hub skills (relaxed to archive-only for
  bundled when prune-builtins mode is on, `agent/curator.py:1508-1521`);
  never delete — archiving is "the maximum destructive action"; never touch
  pinned or protected skills; don't use zero usage counters as evidence
  either way; the consolidation bar is "would a human maintainer write this
  as N separate skills, or as one skill with N labeled subsections?"
- Method: cluster by prefix/domain, then per cluster merge into an existing
  umbrella, create a new umbrella, or demote a narrow sibling to
  `references/`/`templates/`/`scripts/` under the umbrella — with package-
  integrity rules (never flatten a skill that has support files without
  re-homing them).
- Required output: a human summary plus a structured YAML block
  (`consolidations: [{from, into, reason}]`, `prunings: [{name, reason}]`);
  every archived skill must appear in exactly one list.
- Dry-run mode prepends `CURATOR_DRY_RUN_BANNER` (`agent/curator.py:317-341`)
  turning the same pass into report-only.

The fork mutates skills through the ordinary tools (`skill_manage` patch/
create/write_file, `skill_manage action=delete` = archive with an
`absorbed_into` declaration, `terminal` for mv-into-archive). Afterwards the
orchestrator diffs before/after, classifies removed skills into consolidated
vs pruned from the fork's tool calls and YAML (`agent/curator.py:530-916`),
and writes `logs/curator/<YYYYMMDD-HHMMSS>/{run.json,REPORT.md}`
(`agent/curator.py:490-510,1008-1382`).

**Live-install evidence** (read-only): `~/.hermes/skills/.curator_state`
shows `run_count: 10`, last run 2026-08-22, ~117 s; the latest REPORT.md
records "Model: `gpt-5.6-sol` via `openai-codex` · Agent-created skills:
9 → 9", 20 tool calls, 0 archived; `skills/.archive/` holds 13 pruned
bundled built-ins (apple-notes, arxiv, …). The feature demonstrably runs in
production on this machine.

## 5. Profile-home behavior (ticket question a)

Every path the curator touches resolves **dynamically** through
`get_hermes_home()`: state file (`agent/curator.py:66-67`), skills dir/usage
sidecar/archive dir (`tools/skill_usage.py:81-87,125-126`), backups
(`agent/curator_backup.py:71`), reports (`agent/curator.py:490-510`), and
config via `hermes_cli.config.load_config()` which reads the home's
`config.yaml` (`agent/curator.py:119-133`; `hermes_constants.py:397-403` per
the #10 note). Runtime-verified with the install's venv under a scratch
`HERMES_HOME`: all five paths resolved under the scratch home and
`should_run_now()` seeded the deferred-first-run state there.

Consequences for `HERMES_HOME=~/.hermes/profiles/argus-<slug>`:

- The native curator inside an Argus-profile Hermes session is fully
  profile-scoped: its own `.curator_state`, `.usage.json`, `.archive/`,
  thresholds from the profile's `config.yaml`. It will trigger on
  `hermes chat` startup once the profile is ≥7 days old (first run is seeded
  + deferred one interval on the profile's first session).
- But it curates **the profile's `skills/` dir** — bundled built-ins cloned
  at profile creation plus whatever Hermes writes there — never
  `.argus/skills/`. With `prune_builtins` defaulting on, it would slowly
  archive unused built-ins inside the Argus profile.
- **Recommendation:** set `curator: {enabled: false}` in the per-profile
  `config.yaml` at `argus init` (config is per-profile, so global Hermes
  keeps its curator). This preserves single-writer discipline: the Argus
  curator is the only curator, and there is no background LLM pass burning
  tokens inside orchestrator profiles. (If left on it is merely noisy, not
  dangerous — it cannot see `.argus/` at all.)

## 6. The memory half (ticket question b)

**Checked, absent:** there is no native memory curator. The complete set of
native memory hygiene is:

- Load-time exact-duplicate dedup of §-entries
  (`tools/memory_tool.py:266`).
- Char-budget enforcement that *refuses* over-limit writes and tells the
  model to "'remove' stale or less important entries"
  (`tools/memory_tool.py:336,400`) — model-driven, per-write, no schedule.
- The turn-based background review (nudge interval, #10 note) which *adds*
  memories and skills; its skill-writing prompt explicitly defers cleanup:
  "the background curator handles consolidation"
  (`agent/background_review.py:114,200`).

So SPEC §5.1's "deduplicates/compacts the memory files" is an Argus
invention, and the format gap makes that a feature, not a bug: the native
curator's §-entry assumptions never come into play because it never opens the
files. What *is* liftable for the memory pass is the curator's **shape**
(deterministic sweep first, LLM consolidation second, archive-never-delete,
structured YAML report, dry-run mode) applied to Argus's own format: the
`MEMORY.md` index + per-fact files, where — unlike Hermes §-entries — each
fact file has a filesystem mtime and git history to anchor staleness on. The
Reviewer's §-folding duty (#10 note, "Format gap") stays as specified there;
the curator pass then operates purely on already-folded index+fact files.

## 7. Skills-store gap (ticket question c)

The native curator understands skill *packages* well — SKILL.md frontmatter
`name:`, category nesting, `references/`/`templates/`/`scripts/`/`assets/`
support dirs, and package-integrity rules for moving them
(`agent/curator.py:344-486`; `tools/skill_usage.py:330-413`). All of that
maps 1:1 onto Argus's `.argus/skills/` SKILL.md store.

What does not transfer:

- **Location**: enumeration and archiving are hard-wired to
  `get_hermes_home()/skills`; `skills.external_dirs` is consulted by the
  skills *loader* (`tools/skills_tool.py:497-506`) but never by
  `skill_usage`/`curator` (checked absent, §3). Pointing the native curator
  at `.argus/skills/` is not configuration-reachable.
- **Telemetry source**: `.usage.json` is bumped only by Hermes's own tool
  calls. Argus skills are exercised by Claude/Codex sessions Hermes never
  sees, so an Argus clone needs its own activity source. The natural one:
  the Reviewer already tails every session transcript (SPEC §5.1), so it
  bumps an `.argus/skills/.usage.json` record whenever a transcript shows a
  skill being loaded/referenced; git log dates on the skill dir are the
  fallback anchor for skills predating telemetry.
- **Provenance**: Hermes's agent-created-only rule exists to protect
  user-authored skills. Argus's equivalent split is Johan-authored vs
  Reviewer-authored skills — the registry provenance model (SPEC §5) already
  supplies this; record `created_by` in the usage sidecar and pin
  Johan-authored skills by default.

## 8. Lift vs re-spec verdict

Per curator behavior, stated implementably. "Lift" = port the cited logic
near-verbatim (it is small, pure Python, and battle-tested on this machine);
"re-spec" = the concept survives but the mechanism must be Argus's own.

**(i) Scan — re-spec the enumeration, lift the sidecar pattern.**
Native scanning is `rglob("SKILL.md")` under the Hermes home plus the
`.usage.json` sidecar; neither can be pointed at a repo. Argus re-specifies
enumeration as: walk `.argus/skills/**/SKILL.md` (skip `.archive/`, reuse the
`EXCLUDED_SKILL_DIRS` set, `agent/skill_utils.py:27-44`) and the memory index
(each `MEMORY.md` line ↔ per-fact file; flag orphans both ways). Lift
verbatim: the sidecar-record schema (`tools/skill_usage.py:460-474`), keyed
by frontmatter `name:` with directory-name fallback
(`tools/skill_usage.py:394-413`), maintained at `.argus/skills/.usage.json`
by the Reviewer (§7 telemetry source), locked with the same
lock-file + atomic-replace discipline (`tools/skill_usage.py:90-123,496-518`).

**(ii) Staleness judgment — lift the deterministic tier verbatim; adapt the
LLM tier's prompt.** Port `apply_automatic_transitions`
(`agent/curator.py:255-311`) + `latest_activity_at`
(`tools/skill_usage.py:146-164`) as-is: anchor = newest use/view/patch else
`created_at`; ≥30 d → `stale`, ≥90 d → archive, activity on a stale skill →
reactivate; `pinned` bypasses everything; unknown-record skills are seeded
and deferred one cycle (this seed-on-first-sight rule is what makes the first
Argus pass safe — nothing is archived until 90 days of *observed* non-use).
For memory facts, the same function applies with anchor = max(fact-file git
commit date, last Reviewer touch). The LLM judgment tier: lift the
`CURATOR_REVIEW_PROMPT` structure (`agent/curator.py:344-486`) — umbrella
framing, the "N skills vs one skill with N subsections" bar, package-
integrity rules, the required `consolidations`/`prunings` YAML block, and the
`CURATOR_DRY_RUN_BANNER` mechanism (`agent/curator.py:317-341`) — rewriting
tool references (`skill_manage`/`terminal` → codex-exec file edits under
`.argus/`) and adding a memory section (merge duplicate facts, fold stray
§-appends the Reviewer missed, compact the index). Brain: `codex exec` per
SPEC §5.1, replacing the native aux-slot fork
(`agent/curator.py:1676-1815`), which is Hermes-runtime-specific and not
liftable.

**(iii) Archive action — lift the semantics wholesale.** Move the whole skill
directory to `.argus/skills/.archive/<name>/` (flatten, timestamp-suffix on
collision), set sidecar state `archived`, never delete — a direct port of
`archive_skill` (`tools/skill_usage.py:672-725`) minus the built-ins
suppression list (no re-seeder exists for `.argus/skills/`). Memory archive
is the new-spec mirror: move the per-fact file to
`.argus/memory/.archive/` and delete its index line. Replace the tar.gz
backup layer (`agent/curator_backup.py`) with what the repo already gives us:
a git commit before the pass ("pre-curator snapshot") — same rollback
guarantee, no snapshot files; keep `hermes curator restore`'s semantics as an
`argus curator restore <name>` that moves the dir back.

**(iv) Schedule — re-spec the trigger, lift the gating state machine.**
Native triggering (session-startup hook + gateway hourly poll) doesn't exist
in Argus's watcher world. But `should_run_now()` + `.curator_state`
(`agent/curator.py:66-113,198-252`) is exactly the right idempotency layer
for SPEC §5.1's "weekly": persist
`{last_run_at, last_run_summary, last_report_path, paused, run_count}` at
`.argus/curator_state.json`; the Reviewer checks it on every debounced
invocation and runs the pass when `now − last_run_at ≥ 7 d` (the same
opportunistic-poll-with-internal-gate design as
`gateway/run.py:15720-15733`); first run on a fresh repo is seeded + deferred
one interval; dry-run never bumps `last_run_at`
(`agent/curator.py:1478-1483`). Also lift the per-run report convention —
`run.json` + human `REPORT.md` per pass (`agent/curator.py:490-510`) under
`.argus/reports/curator/` — it is the audit trail SPEC §5.1's retro loop
wants. Finally, disable the native curator in Argus profiles
(`curator: {enabled: false}` in the per-profile `config.yaml`, §5) so the
clone is the only curator in play.
