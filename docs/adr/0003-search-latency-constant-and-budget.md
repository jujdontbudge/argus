---
status: accepted
---

# `argus search` latency: the measured constant, and what a budget for it is *for*

#105 measured `argus search` latency across a 180-minute fleet soak
(`docs/acceptance/soak.txt` §9) and found it linear in corpus with no knee. The
numbers were good and nothing could fail against them, because SPEC states no
latency budget anywhere: §5.2, §10 and §12 are capability claims, and 25 ms
answers them exactly as well as 2,500 ms would have. This ADR writes the
constant down, and pre-registers a threshold for #109 in
`scripts/soak/latency.ts` — committed before the run it judges, the way
`scripts/soak/analyze.ts` was committed seven seconds before #105 started.

Why an ADR and not SPEC: SPEC states what Argus *is*, and a measured cost with
a named origin and a shelf life is not that. This is the same shape as
ADR-0002, which records the watcher-brain cadence against #8's measured
~5.3 s/call rather than putting a benchmark in SPEC. SPEC §10 gains a one-line
pointer here so the number is findable from the claim it qualifies.

## The constant

**Search cost tracks the number of rows a query MATCHES, not the number of rows
archived. At ~0.7–0.9 ms per 1,000 matched rows on an idle machine, a query
matching the whole of a 21,000-row archive answers in under 17 ms.**

Measured for this ADR against #105's own final store
(`/private/tmp/argus-soak-czkoLx/repo/.argus/archive.db`, 21,069 rows, copied
to scratch and opened read-only), using production's exact statement from
`src/search/search.ts:63-77`, median of 9 runs, machine otherwise idle:

| FTS match expression | matched rows | median ms |
| --- | ---: | ---: |
| `"nonexistentterm"` | 0 | 0.02 |
| `"traffic"` | 10,754 | 7.89 |
| `"cursor"` | 11,400 | 8.17 |
| `"soak" AND "traffic"` | 10,754 | 9.78 |
| `"sqlite" AND "backlog"` | 11,407 | 9.17 |
| `"provenance" AND "cursor"` | 11,389 | 8.00 |
| `"provenance"` | 20,925 | 14.80 |
| `"provenance" AND "backlog"` | 20,780 | 16.65 |

Linear in matched rows, ~0.7 ms/1k for a single term and ~0.8–0.9 ms/1k for a
two-term AND, through the origin — a query that matches nothing costs nothing.

## The three per-query numbers from #105, and what they actually are

#105 §9 reports, per 1,000 **archived** rows, from warmed 15-minute bucket
medians:

| query | ms per 1,000 archived rows | 95% CI | Theil-Sen |
| --- | ---: | --- | ---: |
| `provenance cursor` | 0.404 | [−1.303, +2.111] | 0.505 |
| `sqlite backlog` | 1.518 | [+0.698, +2.339] | 1.308 |
| `soak traffic` | 2.154 | [+1.725, +2.584] | 2.113 |

**These three numbers must not be flattened into one, and they must also not be
read as three query classes.** Both readings are wrong, in opposite directions,
and the second one is the one #105's own wording invites.

- **Not one number**, because `provenance cursor` did not grow: r(rows) −0.070
  against r(load1) +0.394, and a warmed OLS whose CI spans zero. Its 193.78 ms
  maximum is the machine, not the corpus. Averaging it with `soak traffic`'s
  17× growth produces a figure that would make a load spike look like corpus
  growth.
- **Not three classes either.** #105 calls them broad / mid / cursor-scoped,
  which implies selectivity is the reason. It is not. The seed corpus is filler
  drawn from an 18-word vocabulary (`scripts/soak/seed.ts:46-59`) and every
  traffic message contains all 18 of those words plus "traffic"
  (`scripts/soak/traffic.ts:53`). So all three query strings match roughly half
  the final corpus (11,389 / 11,407 / 10,754 rows), all three gain ~1 matching
  row per row archived, and — as the table above shows — **on an idle machine
  today all three cost the same 13.4–13.6 ms against that store.** The spread in
  the per-archived-row slopes is a property of #105's particular run: where each
  query's posting lists started in the seed, and a machine whose load fell
  roughly fourfold across the three hours.

The distinction worth keeping is therefore not *broad vs narrow* but
**corpus-driven vs load-driven**:

> A query gets slower as the number of rows it MATCHES grows. A query whose
> match count is not growing does not get slower, and a latency excursion on
> such a query is the machine, not the archive.

That is what `scripts/soak/latency.ts` encodes, by giving the flat query a
shape rule instead of a numeric bar.

The load term is not small and is worth stating with a like-for-like number:
#105's final 15-minute bucket, on a machine shared with #107's live drives and
Johan's builds, reported 21.59 / 23.11 / 24.82 ms for the three queries. The
same store, the same queries, idle: 13.59 / 13.43 / 13.39 ms. Roughly 1.7×,
same corpus.

## Extrapolation, and its shelf life

From #105's linear fits, reproduced by `scripts/soak/latency.ts` against the raw
series (100 ms and 1 s crossings, broad query: 56,107 and 473,890 rows —
matching §9's "around 55k" and "~470k"):

| corpus | provenance cursor | soak traffic | sqlite backlog |
| --- | ---: | ---: | ---: |
| 21k rows (#105) | ~22 ms | ~23 ms | ~25 ms |
| 100k rows | 62 ms | 194 ms | 146 ms |
| 500k rows | 204 ms | 1,046 ms | 743 ms |

#105's generator produced ~3,600 rows/hour, so 100k rows is about **25 days of
continuous heavy traffic**. This is not a problem now and it is a problem
eventually, which is why it is written here rather than filed as an incident.

## Who actually calls search, and what each one tolerates

The budget follows the consumers, so they were enumerated from the tree rather
than assumed. There is exactly one FTS `MATCH` in Argus, `src/search/search.ts:75`.

| consumer | cadence | tolerance |
| --- | --- | --- |
| `argus search` at a terminal (`src/cli.ts:292`) | one-shot, interactive | **Not knowable from the code.** No timeout, no spinner, no cancellation, no pagination past `LIMIT 20`. |
| An agent calling `argus search` as a tool (`skills/argus-orchestrator/SKILL.md:281`; the AGENTS.md pointer block at `src/up/scaffold.ts:68`) | none — the model decides; SKILL.md places it last in a four-step zoom order at "the lowest useful resolution" | **Not knowable from the code.** A frequency hint is not a latency tolerance. Structurally it sits inside a ~5.3 s brain call (ADR-0002), so tens of ms are invisible — but that is an observation, not a budget. |
| `src/harness/batch-search.ts:1064`, the #92 acceptance harness | twice, at the end of a batch | **Not knowable from the code — unbounded.** It awaits `child.exited` with no timeout, while the same file sets `sessionTimeoutMs = 600_000` at :686. The author reaches for a timeout when there is a tolerance to state, and did not here. |
| `scripts/soak/sampler.ts:109` | every 30 s | Knowable and vacuous: three queries plus RSS collection must fit in 30 s. |

**The tight-tolerance consumer does not exist.** A watcher polling search every
250 ms would have a real budget, and there is no such thing in this tree.
`ARGUS_WATCH_POLL_MS` (`src/watch.ts:263`, default 250) and `src/eyes/cap.ts:64`
are the only 250 ms cadences here, and neither calls `openArchiveSearch`. The
watchers *write* archive rows; nothing reads them back through FTS on a clock.

That absence decides the shape of the budget. With no consumer on a cadence,
an absolute-milliseconds bar protects nobody: 25 ms and 250 ms are equally
invisible to a human at a prompt, and both are noise inside a 5.3 s brain call.
A bar picked in that range would be arbitrary; a bar picked high enough to
matter to a human could not be breached inside a three-hour soak. So the
pre-registration budgets **the constant**, not the milliseconds.

## The pre-registered threshold for #109

Implemented in `scripts/soak/latency.ts`, committed before #109 runs, with the
full argument in its docblock. `scripts/soak/analyze.ts` is untouched: #105's
RSS verdict is a record and stays reproducible.

- **Method fixed in advance:** warmed 15-minute bucket medians (buckets starting
  at ≥ 30 min, the warm-up `analyze.ts` already pre-registered), regressed on
  that bucket's row count. Bucket width is fixed here because #105 §4b's own
  objection to its post-hoc floor metric was that width is a free parameter the
  answer moves with. OLS with a 95% CI plus Theil-Sen as an outlier-immune
  second opinion; **estimators on opposite sides of a bar are reported as
  `STRADDLE`, not resolved**, exactly as #105 §3 reported its final-hour RSS.
- **`soak traffic`: 5.2 ms per 1,000 archived rows.** 2 × the upper bound of
  #105's own 95% CI (2.584); 2.41× its point estimate.
- **`sqlite backlog`: 4.7 ms per 1,000 archived rows.** 2 × its CI upper bound
  (2.339); 3.10× its point estimate.
- **`provenance cursor`: no numeric bar.** Its CI, [−1.303, +2.111], is wide
  enough to contain the broad query's point estimate — ten buckets cannot
  distinguish 0.4 from 2.1 here, so any number would be invented rather than
  measured. Its rule is qualitative: it fails only if its CI stops including
  zero **and** |r(rows)| ≥ |r(load1)|, i.e. only if the growth is corpus-shaped.
  A load excursion on this query is reported as `GREW WITH LOAD, NOT CORPUS`
  and is not a failure.
- **Absolute backstop: 5,000 ms.** Not invented — it is
  `PRAGMA busy_timeout = 5000` from `src/search/search.ts:105`, the only
  latency-shaped number the search path already commits to. It is a catastrophe
  detector and nothing short of a hung store reaches it.
- **A query string not in the table is `UNREGISTERED`, never defaulted**, and a
  registered query #109 does not run is reported as `NOT RUN`.

**Why 2×.** 1.2× sits inside the sampling noise of #105's own numbers and would
fire on a clean re-run. 10× is unreachable by anything short of losing FTS
entirely, which needs no threshold to notice. 2× is the scale of the
regressions this path can actually suffer — an index not used, bm25 widened
over more columns, the JOIN losing its rowid path, `snippet()` evaluated over
the match set instead of the limit. The bar sits above the top of the current
CI and below the bottom of that class. The rule ("twice the top of #105's own
CI") was fixed first; the arithmetic followed.

Run against #105's own series it returns
`provenance cursor=STILL FLAT soak traffic=WITHIN BUDGET sqlite backlog=WITHIN BUDGET`
— so it does not fail the code that produced it, and `tests/soak-latency.test.ts`
pins that.

### The regime this protects, said plainly

This is a **regression detector on a three-hour timescale**, not a
user-experience guard. It trips when a code change makes search cost more per
row than #105 measured. It deliberately cannot trip on corpus growth: at 3,600
rows/hour the broad query needs ~25 days to reach 194 ms, and no 3-hour soak
sees that. A threshold that tripped on the 25-day timescale would be measuring
the wrong thing; one that tripped next week would be measuring load.

### Precondition, stated because the script cannot check it

**The two numeric bars are only valid for a #109 that re-runs
`scripts/soak/seed.ts` and `scripts/soak/traffic.ts` unchanged.** The constants
are per-archived-row, and the conversion from archived rows to matched rows is
a property of that seed vocabulary and that traffic text. Change the corpus
generator and the bars do not transfer — the per-matched-row constant at the
top of this ADR does, and new bars would have to be derived from it.

## Open questions, deliberately not filled in

1. **No absolute latency budget for `argus search` is stated here, because no
   consumer states a tolerance.** Whether 194 ms at 100k rows, or 1,046 ms at
   500k, is acceptable to a human at a prompt is a product decision nobody has
   made. Inventing 200 ms at a desk is exactly the move this ADR exists to
   avoid. If a consumer ever acquires a real tolerance — a watcher that polls
   search, a TUI that searches per keystroke, an agent loop with a step budget —
   that consumer's number belongs here and this section should shrink.
2. **The measured constants are query-time only.** The sampler times the
   prepared statement (`scripts/soak/sampler.ts:117-126`); a human running
   `argus search` also pays Bun startup, the dynamic `import()` at
   `src/cli.ts:310`, `gitRoot`, and opening the database. That fixed overhead
   has never been measured and is not included in any number above.
3. **`provenance cursor` and `sqlite backlog` have near-identical selectivity
   yet #105 measured 0.404 against 1.518 ms per 1,000 archived rows.** The
   idle-machine table above says they cost the same today. The mechanism behind
   the spread during #105 — posting-list start size, load trajectory, or
   something else — is not identified, and this ADR does not guess. Breaking the
   rows ≡ time collinearity (#105 §7's first suggestion: two traffic-rate arms)
   would settle it for latency as well as for RSS.
