---
status: accepted
---

# Watcher brain defaults: cadence, knobs, and failure behavior

The defaults `.argus/config.yaml` ships with for the watcher brains, decided in the
ticket #9 grilling session with Johan (2026-08-24), informed by the #8 benchmark
(`research/watcher-brains-codex-exec.md`: luna@low, median ~5.3 s/call, ~18 K-token
fixed overhead per call).

## The defaults

- **Brain:** `gpt-5.6-luna` at `model_reasoning_effort=low`, as one global `brain:`
  block inherited by Reviewer and Digest, with optional per-eye override subsections.
- **Reviewer cadence:** quiet-window debounce — fire after 30 s without a new turn,
  max-wait 300 s so an always-active session is still reviewed; each invocation
  coalesces every turn accumulated since the last fire into one call.
- **Digest cadence:** same 30 s quiet window but max-wait 120 s, plus immediate
  out-of-band fires on session lifecycle events (start, stop/blocked hooks — §6), so
  the digest's `status:` field — Hermes' slow-poll signal — flips fast while the
  narrative stays lazily coalesced.
- **Failure behavior:** never drop content. Nonzero exit / `turn.failed` → retry with
  exponential backoff (5 s base, ×2, cap 5 min); retries are infinite. The coalesce
  buffer keeps absorbing new turns, so recovery calls carry everything missed. A
  watcher more than 15 min behind raises an alert (event file + `cmux notify`)
  instead of lagging silently.
- **Per-attempt deadline:** 120 s of wall time. The deadline is composed with daemon
  shutdown, kills the `codex exec` child, and turns the attempt into an ordinary
  retryable failure. `createCodexBrain` owns the production default;
  `Brain.evaluate` and `openRetro` expose shorter overrides for callers and tests.
- **Concurrency:** machine-wide semaphore of 2 concurrent `codex exec` calls across
  all repos and eyes.
- **Curator:** `interval_days: 7` — SPEC §5.1's "weekly" and the `should_run_now()`
  7-day gate lifted from Hermes in #16 (`.argus/curator_state.json`, seed-and-defer
  first run, dry-run never bumps the clock) agree; triggered from the Reviewer's
  debounced loop.

## Where defaults live

Hard-coded in the Argus checkout. `argus up` scaffolds a fully commented
`.argus/config.yaml` that documents every default; a repo's file contains only
overrides. `git pull` therefore improves defaults across all repos without touching
N config files — consistent with ADR-0001's run-from-checkout philosophy.

## Considered options

- **Per-turn brain invocation (no debounce)** — rejected: ~18 K input tokens of fixed
  overhead per call makes coalescing bursts nearly free, and the ~5 s call floor makes
  per-turn firing pointless for a background watcher.
- **Materializing default values into each repo's config.yaml** — rejected: frozen
  copies rot as defaults improve.
- **A global `~/.argus/config.yaml` layer** — rejected: a third layer with no driver
  yet on a single-user, single-machine tool.
- **Give-up-after-N retries** — rejected: dropping content breaks the §5.1
  no-turn-skipped invariant; quota windows pass on their own.
- **No per-attempt deadline** — rejected by #114. #8 measured a ~5.3 s median and
  #113 measured the exact live Retro scan at 8.1 s, while #112 observed the same
  call still running after two minutes. A 120 s deadline is therefore about 23×
  the benchmark median and 15× the healthy live scan: broad headroom for a slow
  answer, but the already-observed tail is a failed attempt rather than an
  unbounded new operating mode. #86's 512 MiB in-process ceiling and #109's
  30-second RSS sampling / 5-minute floor buckets both require the watcher loop to
  regain control; two minutes bounds that blind interval below one #109 bucket.
- **Concurrency cap 4 (the measured-clean number)** — rejected in favor of 2:
  watchers never need speed, the quota is shared with Johan's interactive Codex
  sessions, and exec-mode 429 semantics are unverified (#8).

## Consequences

- A chatty session is seen at worst every 5 min (Reviewer) / 2 min (Digest), not
  per-turn — accepted for the fixed overhead saved per avoided call.
- Retry-forever can lag arbitrarily during a long outage; the 15-min alert makes
  that loud rather than fixing it. One attempt cannot lag forever: its timeout
  reaches the normal failure path, releases the machine-wide slot, and contributes
  to the 15-min alert episode. Accepted: the no-skip invariant outranks freshness,
  so the original content remains pending and retries after backoff.
- The model slug is a churn risk (docs migration, 5.4-mini deprecation noted in #8);
  it lives in one place in the checkout, so re-verification before release and any
  later swap is a one-line change.
