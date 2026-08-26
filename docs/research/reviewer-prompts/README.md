# Reviewer prompts: splitting the ask (#69) and the fact/skill boundary (#71)

Both tickets came out of [#54's per-eye benchmark](../watcher-brain-tiers.md).
Both are measured here against #54's own frozen cases, at #54's settled tier —
`gpt-5.6-luna` @ `low`, the ADR-0002 default. **The tier is not a variable in
this study and was not changed.** #54 measured `luna@max` as *worse* at exactly
this judgment (7x output tokens, 5/9 recall vs 9/9, consolidates real
distinctions away), and SPEC §1 item 8 forbids the metered option regardless.

## What was measured

Two prompt states, same brain, same cases, 3 attempts each:

- **`frozen`** — the red baseline. Replays the exact prompt bytes #54 captured
  from the production Reviewer: one conflated ask, one schema carrying all
  three kinds. Never rewritten here; it is an artifact of a settled study.
- **`boundary`** — the prompts as this branch leaves them: the #69 split
  (extraction, then a separate skills writer) *with* the #71 environment
  boundary stated from both sides.

Cases are #54's, with their human-checkable ground truth: `S1` (a procedure is
genuinely present, scattered across turns), `S2` (status chatter, `maxProcedures:
0`), `S3` (the hard one — a real method scattered over six turns), `S4` (a one-off
incident, `maxProcedures: 0`), and `R4` (the dense case carrying the `cmux must be
>= 0.64.22` environment fact that #71 is about).

Reproduce:

```
bun docs/research/reviewer-prompts/measure.ts --variant current --label boundary --rep 3
bun docs/research/reviewer-prompts/grade.ts
bun docs/research/reviewer-prompts/grade.ts --dump S3   # the human read
```

## Result

```
label       case                      n  procs  any  over-gen  cmux:fact  cmux:skill
frozen      R4-dense-multi-fact       3      3    3         0          2           3
frozen      S1-procedure-present      3      2    2         0          0           0
frozen      S2-no-procedure           3      1    1         1          0           0
frozen      S3-scattered-procedure    3      2    2         0          0           0
frozen      S4-one-off-incident       3      3    3         3          0           0
boundary    R4-dense-multi-fact       3      0    0         0          3           0
boundary    S1-procedure-present      3      1    1         0          0           0
boundary    S2-no-procedure           3      0    0         0          0           0
boundary    S3-scattered-procedure    3      1    1         0          0           0
boundary    S4-one-off-incident       3      0    0         0          0           0
```

**#71 is closed on the measured case.** `R4`'s cmux version floor was written as
a *skill* on 3 of 3 attempts before ("Upgrade cmux before acceptance testing",
with steps) and on 0 of 3 after; it is now recorded as a project fact on 3 of 3,
up from 2 of 3.

**#69's over-generalisation is gone on the measured cases.** The two cases whose
ground truth says `maxProcedures: 0` produced a procedure on 4 of 6 attempts
before and 0 of 6 after.

**The recall trade is real but too small to call.** On the two cases that *do*
contain a procedure, the count fell from 2-of-3 to 1-of-3 each. At n=3 that is
one attempt, which is noise — #54's own caveat, carried forward. What the dump
shows is better than the count suggests: on `S3` the frozen prompt's two
"procedures" were restatements of ticket #38's episode (`scope-drift-validation-loop`,
`degrade-brain-errors-to-audited-silence`), while the boundary prompt's single
one is the transferable method ground truth asks for (`extend-an-existing-signal-
pipeline-with-policy-and-gates`). Fewer procedures, and the ones that survive
are the abstraction rather than the narrative.

## Caveats, carried forward from #54

- **n=3, five cases.** Nothing here separates two prompts that differ by one
  attempt. Only the 3/3-to-0/3 movements (`R4` skills, `S4` over-generalisation)
  are large enough to read as signal.
- **Few procedure cases exist at all.** `S1` and `S3` are the only true-positive
  procedure fixtures. The tail of procedure-writing remains unproven, and the
  recall trade above should be re-measured if more cases are ever written.
- **Prompt-level only.** This measures what the brain returns. The schema split
  is what makes the failure *unreachable*: a procedure returned by the extraction
  pass is a schema miss, not a write, so it can never reach `.argus/skills/`
  even on an attempt the prompt fails to steer.
