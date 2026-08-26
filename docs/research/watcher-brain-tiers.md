# Watcher brain tiers: luna max vs sol low/medium, per eye

Researched 2026-08-26 for Argus ticket
[#54](https://github.com/JohanSardar/argus/issues/54), revisiting the
[#9](https://github.com/JohanSardar/argus/issues/9) / [ADR-0002](../adr/0002-watcher-brain-defaults.md)
default of `gpt-5.6-luna` @ `low` with budget explicitly on the table.

Measured, not argued: **153 real `codex exec` calls** across 5 candidate configs
over one fixed set of 20 cases built from real transcripts and real commits on
this machine, with the three decisive cases replicated three times each.
Harness, cases, per-case ground truth and every raw verdict are committed under
[`brain-tiers/`](brain-tiers/).

---

## The answer, with the price

**Don't buy anything. #9's default survives a funded re-examination, and both
upgrade directions measured *worse*, not better.**

| Eye | Recommendation | Change | Marginal $/mo | Why |
| --- | --- | --- | --- | --- |
| **Reviewer** (USER.md / MEMORY.md) | `gpt-5.6-luna` @ `low` | **no change** | **$0** | Best measured config on both axes. `max` recalled **5/9** preferences vs low's **9/9**; `sol` wrote unsupported USER.md entries in **4–5 of 6** reps vs low's 2. |
| **Skills writer** | `gpt-5.6-luna` @ `low` | **no change** | **$0** | Same brain call. Its real defect is in the prompt and **every tier fails it identically**. |
| **Digest** | `gpt-5.6-luna` @ `low` | **no change** | **$0** | **43/43 correct** at the floor. Nothing to buy. |
| **Retro** (incl. scope drift) | `gpt-5.6-luna` @ `low` | **no change** | **$0** | **30/30 correct** at the floor, including three false-positive traps. |
| **Honcho ingestion** | not this knob | n/a | n/a | The deriver model is a real knob, but `luna`/`sol` **cannot be set on it at all**. |

**Total cost of the recommendation: $0/mo.** The upgrades Johan offered to pay
for would cost **+$20/mo** (luna max) or **+$1,466/mo** (sol) per repo, and buy
negative quality on the eye that matters most.

If Johan wants to spend the dollar anyway, the *only* defensible change is
`gpt-5.6-luna` @ `medium` on the Reviewer (+$0.91/mo): it made one fewer
unsupported USER.md write (1/6 vs 2/6) at the cost of one recalled preference
(8/9 vs 9/9). **At n=3 that is a coin flip and I am not going to manufacture a
winner from it.** Config block for it is below if he wants it.

### Answering the framing directly

> *"luna is a very very good model but some tasks are too much for luna max"*

On these four jobs, none of them is. The two hardest — scope drift and the
Digest's `status:` judgment — are **saturated at luna @ low**: 30/30 and 43/43,
with every tier producing identical outcomes. There was no headroom for a
better model to occupy.

**And luna @ max is actively worse than luna @ low on the Reviewer.** It emits
**7x the output tokens** (median 2,357 vs 323) and uses them to *consolidate*:
on `R1` it merged three separately-stated preferences into one or two findings,
recalling 5 of 9 across three reps where `low` got 9 of 9 every time. More
reasoning on an extraction task produced tidier, lossier output. That is the
single most useful surprise in this study.

### Where the money would actually go, if spent

| Config (all eyes, one repo, heavy day) | $/mo | vs today |
| --- | --- | --- |
| **luna low — today's default** | **$71.72** | — |
| luna medium | $72.95 | +$1.23 |
| luna max | $91.39 | +$19.67 |
| sol low | $1,537.48 | **+$1,465.76** |
| sol medium | $1,588.43 | **+$1,516.71** |

And dollars are the *soft* constraint. The watchers run `codex exec` on Johan's
ChatGPT subscription, where the currency is quota: OpenAI's published Pro-5x
bands are **1,250–10,000 local messages / 5 h for luna** against **50–500 for
sol** — 25x. At the call volume measured below, **the Digest alone on sol
consumes 13.5%–135% of the entire five-hour allowance**, shared with Johan's own
interactive Codex sessions and the dispatcher. Sol on the chatty eyes is not
expensive; at the pessimistic end of a published range it is a hard stop.

### The config block

The recommendation is that `.argus/config.yaml` needs **no `brain:` block at
all** — the code defaults are correct. Scaffolded for documentation:

```yaml
# Watcher brains — ADR-0002 defaults, re-verified by ticket #54 (2026-08-26)
# over 153 live codex exec calls. Every candidate upgrade measured worse:
#   luna @ max   — 5/9 preference recall vs low's 9/9, 7x output tokens
#   sol @ low    — 5/6 reps wrote an unsupported USER.md entry, 21x the price
#   sol @ medium — 3/9 preference recall, 4/6 bad writes, 21x the price
# Digest (43/43) and Retro scope drift (30/30) are saturated at this tier;
# their judgment is carried by the prompt policy and the eye's own gates.
brain:
  model: gpt-5.6-luna
  reasoning_effort: low
  max_concurrency: 2
```

If Johan wants the one-dollar Reviewer hedge despite the coin flip:

```yaml
# OPTIONAL, +$0.91/mo. Trades one recalled preference (8/9 vs 9/9) for one
# fewer unsupported USER.md write (1/6 vs 2/6). Not separable at n=3.
reviewer_brain:
  model: gpt-5.6-luna
  reasoning_effort: medium
```

> **Implementation note.** `src/eyes/config.ts` reads exactly one `brain:`
> section today; the per-eye override subsections ADR-0002 describes are not
> implemented. The primary recommendation needs no code change at all. The
> optional hedge would need that seam wired first — a small follow-up ticket.

---

## What was measured, and how to re-check it

| | |
| --- | --- |
| Configs | `luna`@`low`/`medium`/`max`, `sol`@`low`/`medium` |
| Cases | 20 (6 Reviewer, 4 Skills, 4 Digest, 6 Retro drift) |
| Runs | **153** (`results/runs.jsonl`), 0 spawn/exit failures, **153/153 schema-valid** |
| Replication | 3 reps on the 3 decisive Reviewer cases; 1–3 on the rest |
| Invocation | `createCodexBrain()` — the real `src/eyes/brain.ts` argv, `-m <model> -c model_reasoning_effort=<effort>` |
| Prompts | built by the **production eyes**, captured verbatim |
| Verdicts | parsed by the **production** `parseVerdict` / `parseDigestVerdict` / `parseDriftVerdict`, then Reviewer findings pushed through the real `applyFindings` provenance gate |

Nothing here is a hand-rolled prompt harness. `harness/cases.ts` hands a
*recording* `Brain` to the real `ReviewerEye` and `DigestEye`, which build and
send their own prompt and their own `--output-schema`; those exact bytes become
the frozen case. The drift cases call the exported `buildDriftPrompt` +
`DRIFT_OUTPUT_SCHEMA` — the same pair `RetroEye.judgeDrift` passes to
`brain.evaluate` (`src/eyes/retro/retro.ts:632`).

**The corpus is real and checkable.** Every Reviewer/Skills/Digest turn in
`harness/corpus.ts` is verbatim from a real transcript with its real uuid, so
any grading claim can be verified against its source line:

```bash
grep 68714bd8-a740-422c-a02d-a077db5beb33 ~/.claude/projects/-Users-johansardar-argus/*.jsonl
```

Every Retro case pairs a real GitHub ticket body (read live via `gh`) with real
commits from this repo's history: `T1` is #53 against the three commits that
implemented it; `T3` is #52 against #49's commits; `T4` is #51's two real
commits plus one genuinely unrelated commit (`7b01678`, ticket #48's ADR work).

**Ground truth lives next to each case** in `cases/<id>.json` under
`groundTruth`, naming the uuid each required fact is actually stated in and the
uuids whose citation would be a provenance error. Reproduce:

```bash
bun docs/research/brain-tiers/harness/build.ts    # rebuild the frozen case set
bun docs/research/brain-tiers/harness/run.ts      # 100 calls, ~45 min
bun docs/research/brain-tiers/harness/grade.ts    # per-run table
bun docs/research/brain-tiers/harness/grade.ts --dump R5   # full verdicts
bun docs/research/brain-tiers/harness/score.ts    # the replicated scores
bun docs/research/brain-tiers/harness/volume.ts   # real call volume
bun docs/research/brain-tiers/harness/cost.ts     # cost model
```

### The volume this is priced against

Derived, not assumed: `harness/volume.ts` replays the **real turn timestamps**
of every Claude transcript under `~/.claude/projects/-Users-johansardar-argus*`
through the **production `Coalescer`** at the ADR-0002 cadences and counts how
many times each eye would actually have fired.

| Day | Turns | Reviewer | Digest | Retro (scan) |
| --- | --- | --- | --- | --- |
| 2026-08-23 | 51 | 4 | 5 | 3 |
| 2026-08-24 | 1,961 | 106 | 123 | 77 |
| **2026-08-25** (busiest) | **6,968** | **242** | **325** | **154** |
| 2026-08-26 (partial) | 2,119 | 59 | 84 | 35 |

Debouncing means call volume is *not* proportional to turn count: a 6,968-turn
day produces 242 Reviewer calls, not 6,968. The ceiling under continuous
activity is 288 / 720 / 144 per day, so the busiest observed day already sits at
~63% of it — adding Codex-side traffic cannot more than ~1.6x these numbers.

**Retro is the exception, and it matters.** Its 154 is the *scan* cadence; the
brain only fires on unjudged work (`retro.ts:503` returns before the brain when
there are no signals and no drift candidates, and `state.judged` retires a
candidate permanently). Real drift questions are bounded by new ticket sessions
with new commits — ~25 on the busiest observed day. The cost model uses 25.

Monthly figures are **heavy-day × 30, one repo** — deliberately pessimistic.

---

## Per eye: what each option actually gets wrong

### Reviewer — USER.md / MEMORY.md (242 calls/day) → **luna @ low, no change**

The highest-stakes eye, and the only one where the configs genuinely separate.
Two counters, never averaged, because the failures are not commensurable: a
**miss** is recoverable — the next session restates the fact, the curator
sweeps, Johan says it again — while a **wrong write** to USER.md is permanent
and silently steers everything downstream.

| Config | `R1` recall — preferences reaching USER.md (target 9) | `R5`+`S2` wrong writes — unsupported USER.md entries (target 0/6) |
| --- | --- | --- |
| **luna low** | **9 / 9** (3, 3, 3) | 2 / 6 |
| luna medium | 8 / 9 (3, 3, 2) | **1 / 6** |
| luna max | 5 / 9 (3, 1, 1) | 3 / 6 |
| sol low | 7 / 9 (3, 2, 2) | 5 / 6 |
| sol medium | **3 / 9** (0, 1, 2) + 1 gate rejection | 4 / 6 |

**luna @ low and luna @ medium are the top two on both axes, and everything
Johan offered to pay for is below them on both.**

**What luna @ max gets wrong: it consolidates.** `R1` states three separate
Johan preferences (agents spawn as tabs not workspaces; finished tabs close
fully; verify by screenshot). `luna`@`low` emitted three findings, each cited to
Johan alone, all three written — on all three reps. `luna`@`max` emitted one or
two on two of three reps, folding the preferences together, and recalled 5 of 9.
It also misfiled: on `R4` it found the durable fact *"cmux must be ≥ 0.64.22"*
and classified it as a **procedure**, so it landed in `.argus/skills/` instead
of `MEMORY.md`. Median 2,357 output tokens against `low`'s 323 (peak 4,942) —
7.3x the reasoning, spent making the answer tidier and lossier.

**What sol gets wrong: it writes things Johan did not say.**

- **A question became a standing preference, reproducibly.** `R5`'s only Johan
  turn is interrogative — *"so evyer tick will start in a cleared context new
  sesion right?"* — and `sol`@`low` wrote `fresh-session-per-ticket`
  (*"Johan wants each ticket worker to start in a new session with cleared
  context"*) on **3 of 3 reps**; `sol`@`medium` on 2 of 3. He may want that; he
  may have been asking precisely because he doesn't. Neither is knowable from
  the block. **`luna`@`low` and `luna`@`medium` declined on all three reps.**
  This is the permanent-damage failure mode, and it is the one place where the
  model class separates cleanly and replicably.
- **`sol`@`medium` hallucinated a source uuid** (`R1` rep 1): it merged all
  three preferences into one finding and cited a uuid appearing in **no block of
  the prompt**. `applyFindings` rejected it, and the most-repeated instruction in
  the corpus reached USER.md from that run not at all. **Observed once** — a real
  failure mode, not a quantified rate.
- Sol's recall was also the worst measured: 3 of 9 at medium, 7 of 9 at low.

**What sol genuinely wins, stated fairly.** On `R4`, the project fact *"cmux
must be ≥ 0.64.22; the machine is on 0.62.2"* was filed correctly as a
`project-fact` (→ MEMORY.md) by **both sol configs and no luna config** —
`luna`@`low`/`medium` missed it entirely and `luna`@`max` misfiled it as a skill.
That is a real MEMORY.md recall gap. It is a *miss*, on the recoverable side of
the asymmetry, and it costs 21.5x plus 10–101% of the five-hour quota band.

**Where the tier is not the lever at all:**

- `R2`, the provenance trap — the same directive relayed by Hermes, echoed by
  the agent, and stated by Johan. **All five configs** cited Johan's uuid alone
  for the USER.md write and routed the Hermes relay to a skill. Provenance
  discipline comes from the prompt and the gate, not the model.
- `R6`, agent-only turns — **all five** correctly wrote zero user-preferences.
- `R3` — see *Limits* below: designed as a fabrication trap, and all five
  converged on the same reading, which on re-inspection is correct and my label
  was wrong. No tier invents facts from nothing.

### Skills writer (the same call as the Reviewer) → **luna @ low, no change**

There is no separate skills eye. Skills are `kind: "procedure"` findings from
the Reviewer's single call (`src/eyes/reviewer/outputs.ts` writes
`.argus/skills/<slug>/SKILL.md`), so it inherits the Reviewer's config and costs
nothing extra.

**The finding here is not about tiers.** On `S3` — a whole real build-worker
session compressed to six turns, where the repeatable method (read the ticket
and the existing module in full → extend, don't duplicate → red test first in
small slices → gates green → post the comment → leave it unmerged) is never
stated in one place — **no config extracted it.** All five produced a
*topic-level* procedure about the scope-drift signal instead:
`conservative-drift-signal-design`, `validate-retro-signal-both-directions`,
`scope-drift-false-positive-policy`. `sol`@`low` produced **no skill at all**.

Five tiers failing the same way is a **prompt defect, not a model defect**. The
Reviewer prompt asks for *"a repeatable procedure worth a reusable skill"* and
never says to prefer the transferable method over the episode's subject matter.
No model tier fixes that sentence. Worth its own ticket.

The n=1 case worth flagging: on `S1`, `luna`@`low` found the tabs preference but
cited `sources=[johan, hermes]`; `applyFindings` requires *every* source to be
Johan-authored, so the gate rejected it and a correct preference never landed.
`luna`@`medium` cited Johan alone and it landed. `S1` was not replicated, so
this is one observation — it is the main thing arguing for the optional
`medium` hedge, and it is why that hedge is a coin flip rather than a loss.

### Digest (325 calls/day) → **luna @ low, no change**

Nothing to buy. Across 4 cases × 5 configs × 1–3 reps: **43 runs, 43 correct.**

- `D1` (a real session's closing turns) → `done` — every config, every rep.
- `D2` (an agent handing two manual tasks to Johan) → `blocked` — every config.
  This is the operationally load-bearing one: `status:` is Hermes' slow-poll
  signal (SPEC §6), so calling it `running` would make Hermes wait on a session
  that is waiting on Johan. No config did.
- `D3` (a ticket brief plus early TDD slices) → `running` — every config; none
  mistook the brief's confident tone for completion.
- `D4` (two sessions interleaved in one coalesced batch) → **exactly two
  entries, correct ids, `done` + `blocked`** — every config.

The only measurable difference is cost: `luna`@`max` spends 1.8x the output
tokens (317 vs 178 median) for the same verdicts. The failure #54 anticipated —
"a bland but harmless digest" — is visible in the sense that `luna`@`low`'s
narratives are the tersest, but every one carried the load-bearing facts (ticket
number, gates green, what remains). Prose polish in a file Hermes reads before
zooming to the raw transcript is not worth $830/mo and a third of the quota.

### Retro, including scope drift (~25 brain calls/day) → **luna @ low, no change**

**30/30. Every config, every case.** #54 called this the hardest judgment in the
system; the cheapest tier already saturates it.

| Case | Truth | luna low / med / max | sol low / med |
| --- | --- | --- | --- |
| `T1` #53 vs its own 3 commits | not drift | ✓ ✓ ✓ | ✓ ✓ |
| `T2` #49 vs commits that also add a standing SPEC §1 principle | not drift (ambiguity → silence) | ✓ ✓ ✓ | ✓ ✓ |
| `T3` #52 vs #49's commits | **drift**, confident | ✓ ✓ ✓ | ✓ ✓ |
| `T4` #51's 2 real commits **+ 1 stray ADR commit** | **drift**, confident | ✓ ✓ ✓ | ✓ ✓ |
| `T5` #50 vs a large multi-subsystem rewrite | not drift | ✓ ✓ ✓ | ✓ ✓ |
| `T6` #38 vs a fix its own author called "beyond the ticket text" | not drift | ✓ ✓ ✓ | ✓ ✓ |

Two results are worth pausing on.

**`T4`, the subtle positive, was caught by every config including luna @ low.**
Two of its three commits are perfectly in scope; the drift is one commit among
them. Every config said `drift=true, confident=true` *and* named it correctly —
*"Unrelated architecture decision records and SPEC documentation."* This is the
failure a cheap model was most expected to have, and none did.

**`T6`, the meanest false-positive trap, produced no false positive anywhere.**
Commit `0cee59c` hardens the very pass ticket #38 adds, and the worker's own
ticket comment calls it *"one fix beyond the ticket text."* Every config read it
as in scope. `T2` — a diff that quietly adds a standing SPEC principle — drew
silence from all five too.

The reason is legible in the source: `buildDriftPrompt` spends twenty lines
stating the burden of proof, naming the safe list, and spelling out the cost
asymmetry, and `decideDrift` then requires `drift AND confident AND` three
articulated prose fields before anything can be filed. The model must clear two
bars it did not set. **That design is doing the work a bigger model was supposed
to do**, which is precisely why buying one changes nothing.

Independent corroboration: #38's own committed live test (`8f112db`,
`src/eyes/retro/live.test.ts`) already pins `luna`@`low` calling a refactor
in-scope and billing webhooks drift, in both directions.

### Honcho ingestion → **not this knob**

**It is a real knob Argus controls, but neither candidate in this ticket can be
set on it.**

The deriver runs server-side in the self-hosted container (`honcho-deriver-1`,
up 31 h) and its model comes from `~/honcho/.env`, verified read-only:

```dotenv
DERIVER_MODEL_CONFIG__TRANSPORT=openai
DERIVER_MODEL_CONFIG__MODEL=z-ai/glm-4.7-flash
DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE=json_object
DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=https://openrouter.ai/api/v1
```

The dial exists. But it is a **different dial with a different menu**: Honcho
speaks the `openai` / `anthropic` / `gemini` API transports with an API key,
while `gpt-5.6-luna` and `gpt-5.6-sol` are ChatGPT-subscription slugs reachable
only through the Codex CLI. There is no configuration in which the deriver runs
luna or sol. The Anthropic transport is independently closed by SPEC §1
principle 7 and by Johan's own words — *"i can never use a antrpic model via api
bc subsciproint doesn allow that."* It is also a **different budget**: deriver
calls bill OpenRouter credits in dollars, not the ChatGPT quota this study is
denominated in.

Per #54's instruction I stop there rather than invent a recommendation for a
dial that does not take these values. Two facts for whoever picks it up: the
deriver is only known to work with `STRUCTURED_OUTPUT_MODE=json_object` on this
model (#17 — `glm-4.7-flash` cannot satisfy `json_schema`), and `DIALECTIC`,
`SUMMARY` and `DREAM` are configured separately and currently all point at the
same model, so changing one is not changing the stack.

---

## Effort level vs model class

The distinction #54 asked for, per eye:

| Eye | Which lever moves quality | Direction |
| --- | --- | --- |
| **Reviewer / Skills** | **Both do — and both point down.** | Within luna, `low ≈ medium ≫ max`: more effort past medium *costs* recall (9/9 → 8/9 → 5/9) by consolidating findings. Across classes at matched effort, luna beats sol on **both** axes (low: 9/9 & 2/6 vs 7/9 & 5/6; medium: 8/9 & 1/6 vs 3/9 & 4/6). The current setting is at the optimum of the tested grid. |
| **Digest** | **Neither.** Saturated at the floor. | 43/43 identical outcomes across all five configs. |
| **Retro** | **Neither.** Saturated at the floor. | 30/30 across all five configs, including all three false-positive traps. |

The general shape, and the practical lever Johan asked about: **effort is the
cheap lever and model class is the expensive one, and on these four jobs neither
buys anything.** The judgment that a bigger brain was supposed to supply is
already supplied by the prompts and the eyes' own gates —
`buildDriftPrompt` + `decideDrift` for scope drift, the all-sources-must-be-Johan
rule in `applyFindings` for USER.md, the `--output-schema` contract everywhere
(153/153 valid across every tier). Where the system still gets things wrong —
the skills writer's topic-vs-method confusion, luna's MEMORY.md miss on `R4` —
the fix is prompt text, not tokens.

---

## Cost and latency

### Per call, measured

| Eye | Config | in tok | out tok | $/call | $/mo (typical) | $/mo (heavy) | % of 5 h band (heavy) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reviewer | luna low | 18,550 | 323 | $0.00410 | $12.66 | $29.75 | 0.5–4.0% |
| Reviewer | luna medium | 18,550 | 428 | $0.00422 | $13.05 | $30.66 | 0.5–4.0% |
| Reviewer | luna max | 18,550 | 2,357 | $0.00654 | $20.20 | $47.47 | 0.5–4.0% |
| Reviewer | sol low | 20,108 | 342 | $0.08727 | $269.67 | $633.59 | **10.1–100.8%** |
| Reviewer | sol medium | 20,108 | 385 | $0.08813 | $272.33 | $639.84 | **10.1–100.8%** |
| Digest | luna low | 18,523 | 178 | $0.00392 | $15.75 | $38.20 | 0.7–5.4% |
| Digest | luna max | 18,523 | 317 | $0.00409 | $16.42 | $39.83 | 0.7–5.4% |
| Digest | sol low | 20,081 | 214 | $0.08460 | $340.11 | $824.89 | **13.5–135.4%** |
| Digest | sol medium | 20,337 | 388 | $0.08911 | $358.21 | $868.80 | **13.5–135.4%** |
| Retro | luna low | 24,499 | 109 | $0.00503 | $1.51 | $3.77 | 0.1–0.4% |
| Retro | luna max | 24,499 | 469 | $0.00546 | $1.64 | $4.10 | 0.1–0.4% |
| Retro | sol low | 26,057 | 55 | $0.10533 | $31.60 | $79.00 | 1.0–10.4% |
| Retro | sol medium | 26,057 | 108 | $0.10639 | $31.92 | $79.79 | 1.0–10.4% |

### Marginal monthly dollars vs today's luna @ low (heavy day, one repo)

| | luna medium | luna max | sol low | sol medium |
| --- | --- | --- | --- | --- |
| Reviewer | +$0.91 | +$17.72 | +$603.85 | +$610.09 |
| Digest | +$0.28 | +$1.63 | +$786.69 | +$830.60 |
| Retro | +$0.03 | +$0.32 | +$75.22 | +$76.02 |
| **All eyes** | **+$1.23** | **+$19.67** | **+$1,465.76** | **+$1,516.71** |

**Two currencies, and the second is the real constraint.** Argus's brains run
`codex exec` on Johan's ChatGPT subscription (SPEC §1 principle 7), so dollars
are what the same traffic *would* cost if metered — the right number if he buys
credits, since credit burn is priced off API rates. What he spends today is
**quota**, and OpenAI's published Pro-5x local-message bands are
**1,250–10,000 / 5 h for luna** against **50–500 for sol**. The `% of band`
column applies the measured call rate (heavy day ÷ 4.8 windows) to those bands.
Reviewer-on-sol at 10–101% and Digest-on-sol at 13.5–135% are not "expensive";
at the pessimistic end of a published range they are a hard stop. Corroborated
by [openai/codex#32250](https://github.com/openai/codex/issues/32250), where a
Pro user reports sol@medium burning 11 percentage points of the five-hour
allowance in one short task.

Note also that sol carries ~1,550–2,000 **more input tokens per call** for an
identical prompt (a larger system prompt), so its effective input multiplier is
~21.7x, not 20x.

### Latency — measured, but do not trust the absolute numbers

Median wall-clock per call: luna low 54 s, luna medium 59 s, luna max 59 s,
sol low 57 s, sol medium 54 s.

**These are inflated several-fold and are not a basis for any decision.** This
machine ran at load average **64 → 417** throughout, from work that was not
mine (two iOS simulators, an Xcode/clang build, a VPN antivirus system
extension, cmux). Every run records `loadAtStart` in `results/runs.jsonl`, so
this is auditable. For scale: #8 measured `luna`@`low` at a **5.33 s** median on
an unloaded machine; the same config measured 54 s here.

What survives the noise is the token counts, which are load-independent:
`luna`@`max` emits **7x** the Reviewer output tokens of `luna`@`low` (2,357 vs 323
median, peak 4,942), because reasoning tokens bill as output. Effort is a
real latency and cost lever — it is just not measurable on this machine tonight.
Since all five configs are debounced background watchers with a 30–60 s quiet
window and a 120–600 s max-wait, none of these latencies is operationally
relevant anyway.

### What this evaluation cost

**153 calls, 3.11 M input tokens, 79.7 K output tokens, $5.91 API-equivalent**
(luna ≈ $0.42, sol ≈ $5.49). Sol is 93% of the study's cost for 40% of its runs
— the same ratio the recommendation turns on. The study cost about 0.4% of one
month of the sol upgrade it rejects.

---

## Limits of this evaluation — read before acting

1. **The Reviewer verdict rests on n=3, and one comparison inside it is a coin
   flip.** `luna`@`low` vs `luna`@`medium` differ by one recalled preference and
   one wrong write across six reps. That is noise, and I have said so rather
   than picking a winner. The comparisons that are *not* coin flips — luna
   beating sol on both axes, and max being worse than low on recall — hold
   across all three reps and in the same direction each time.
2. **One ground truth was wrong, and I am reporting it rather than hiding it.**
   `R3` was designed as a fabrication trap: four transient Johan turns where I
   asserted the right answer was silence. All five configs produced the *same*
   user-preference (Johan wants work finished autonomously with full testing),
   and re-reading the turns — *"now get the rest of theis thing fully built
   nothing needs me right?"* — they are right and my label was wrong. `R3`
   therefore measures **convergence, not fabrication**: it shows no tier invents
   facts from nothing, and it discriminates nothing. It is not scored anywhere
   in this document.
3. **Six drift cases is thin.** A 30/30 sweep is strong evidence that no tier is
   *broken* on scope drift and weak evidence about the tail. Real drift is
   messier than a mismatched ticket/diff pair; even my hardest positive (`T4`)
   is a clean whole-commit intrusion. Ambiguous *within-commit* drift would need
   its own case set, and this study does not speak to it.
4. **`S3`/`S4` ground truth is partly a matter of taste.** Whether a
   watchdog-heartbeat technique is "a reusable procedure" or "one incident" is
   my judgment call. The `S3` conclusion — that all five tiers extract a
   topic-level procedure rather than the transferable method — does not depend
   on it, because the failure is unanimous.
5. **The sol@medium hallucinated uuid is one observation.** Enough to report as
   a real failure mode; not enough to quantify a rate. Do not read it as
   "sol hallucinates uuids" — read it as "it happened once, in the run that also
   had the worst recall."
6. **`R4`'s MEMORY.md gap was not replicated** (n=1 per config). Sol's win there
   is real but single-sample.
7. **Latency is unmeasurable on this machine.** If latency ever becomes the
   deciding factor, re-run on an idle one.
8. **Volume is Claude-side only.** `volume.ts` counts turns from the Argus
   repo's Claude transcripts. Codex-side turns in the same repo raise the turn
   count but, because of coalescing, raise the *call* count sub-linearly —
   bounded by the 288/720/144-per-day ceiling the busiest observed day already
   reaches ~63% of. Multi-repo scaling is linear in repos and is not modelled.
9. **Prices are third-party-sourced and one is promotional.** OpenAI's own
   pricing page returned 403; the figures (luna $0.20/$1.20, sol $4/$20 per 1 M)
   come from two independent aggregators agreeing on an August 2026 effective
   date, with sol's rate explicitly promotional through at least 2026-11-21. The
   **quota bands are from OpenAI's own docs** and are what the decision actually
   rests on. Sol reverting to $5/$30 would strengthen this recommendation, not
   weaken it.
10. **`sol`@`high`/`xhigh`/`ultra` were not tested** — #54 scoped the question
    to sol at low/medium. Given the quota arithmetic they are further out of
    reach, not closer.
11. **Provenance classification was not under test.** Corpus authors are fixed
    and correct by construction, so this measures the brain's *use* of
    provenance, not the classifier's accuracy.

---

## Follow-ups this surfaced (not filed by this ticket)

- **The Reviewer prompt cannot ask for a transferable procedure.** `S3` failed
  identically at every tier; the fix is prompt text in
  `src/eyes/reviewer/reviewer.ts`, not a model tier.
- **ADR-0002's per-eye `brain:` override subsections are not implemented** in
  `src/eyes/config.ts`. Not needed for this recommendation; needed for the
  optional hedge or any future per-eye split.
- **`luna` misfiles crisp environment facts.** `R4`'s cmux-version fact reached
  MEMORY.md from no luna config. Worth a prompt-level nudge on the
  `project-fact` vs `procedure` boundary.

## Sources

- Ticket [#54](https://github.com/JohanSardar/argus/issues/54); prior art
  [#8](https://github.com/JohanSardar/argus/issues/8) (invocation + first
  benchmark), [#9](https://github.com/JohanSardar/argus/issues/9) /
  [ADR-0002](../adr/0002-watcher-brain-defaults.md) (current defaults),
  [#17](https://github.com/JohanSardar/argus/issues/17) (Honcho deriver),
  [#38](https://github.com/JohanSardar/argus/issues/38) (scope-drift signal).
- Code under test: `src/eyes/brain.ts`, `src/eyes/config.ts`,
  `src/eyes/coalesce.ts`, `src/eyes/reviewer/{reviewer,schema,outputs}.ts`,
  `src/eyes/digest/{digest,schema}.ts`, `src/eyes/retro/{drift,schema,retro}.ts`.
- Evidence in this repo: [`brain-tiers/harness/`](brain-tiers/harness/) (build,
  run, grade, score, volume, cost), [`brain-tiers/cases/`](brain-tiers/cases/)
  (20 frozen cases with ground truth),
  [`brain-tiers/results/runs.jsonl`](brain-tiers/results/) (153 raw verdicts
  with per-run token usage and machine load).
- Model availability and effort levels: `~/.codex/models_cache.json`
  (`gpt-5.6-luna` supports `low…max`; `gpt-5.6-sol` supports `low…ultra`).
- Codex usage limits per plan and model:
  [learn.chatgpt.com/docs/pricing](https://learn.chatgpt.com/docs/pricing)
  (Pro 5x — Sol "50-500", Terra "125-1,000", Luna "1,250-10,000" local messages
  per 5 h).
- Sol quota-burn corroboration:
  [openai/codex#32250](https://github.com/openai/codex/issues/32250).
- API list pricing (August 2026):
  [aipricing.guru](https://www.aipricing.guru/openai-pricing/) and
  [cloudzero](https://www.cloudzero.com/blog/openai-pricing/); superseded June
  2026 rates for contrast at
  [finout](https://www.finout.io/blog/gpt-5.6-pricing-2026-sol-terra-and-luna-tiers-explained).
- Honcho deriver configuration: `~/honcho/.env` on this machine (read-only) and
  [`self-hosted-honcho.md`](self-hosted-honcho.md).
