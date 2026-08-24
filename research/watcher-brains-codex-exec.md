# `codex exec` as the watcher brain — findings

Researched 2026-08-24 against the locally installed CLI (**codex-cli 0.149.0**, standalone install at `~/.local/bin/codex`), the local config (`~/.codex/config.toml`, `~/.codex/models_cache.json`, `~/.codex/auth.json` claims), official docs (developers.openai.com/codex/* — which now 308-redirects to learn.chatgpt.com/docs/*), and ~25 real timed runs. Every claim below is tagged with its source. Raw run artifacts live in the session scratchpad (`codex-bench/` — bench-results.json, per-run stdout/stderr/jsonl).

## TL;DR

- **Recommended invocation:** `codex exec --ignore-user-config -m gpt-5.6-luna -c model_reasoning_effort=low -s read-only --ephemeral -C <repo> -c project_doc_max_bytes=0 --output-schema verdict.schema.json --json - < prompt.txt`. Exit 0 on success, 1 on failure; final message is the only thing on plain stdout (JSONL events with `--json`); human noise goes to stderr.
- **Model:** `gpt-5.6-luna` ("Fast and affordable agentic coding model") at effort `low`. Effort `none` also works (verified) but bought no latency on this workload. `gpt-5.4-mini` is deprecated with an explicit "switch to Luna" migration notice.
- **Measured:** median **5.33 s** wall-clock end-to-end (5 runs, range 4.83–5.91 s), ~**18.1 K input tokens** (~9.0 K of it cacheable system prompt; cache hits intermittent) + **~50 output tokens** per call, reasoning tokens 0, 5/5 valid JSON verdicts.
- **`--ignore-user-config` is the load-bearing flag.** It is the only working single lever that drops the user's MCP servers (a `-c 'mcp_servers={}'` override does NOT clear them — verified), plugins/hooks, the per-turn `notify` program, and the `service_tier = "priority"` setting that consumes credits at a higher rate.
- **Quota:** all Codex surfaces (CLI incl. exec, IDE, cloud) share one usage budget on the ChatGPT plan (official pricing doc). Plan is ChatGPT **Pro** (verified from auth token claim). Luna's estimated band is 1,250–10,000 local messages per 5 h even on the lower Pro tier — a debounced per-turn watcher across several repos is comfortably inside it. 4 concurrent invocations ran clean with no 429s (measured).
- **Bonus:** `codex exec review` is a first-class non-interactive code-review subcommand (`--uncommitted`, `--base <branch>`, `--commit <sha>`, same lean flags) — directly relevant to the Reviewer watcher.

---

## 1. Exact non-interactive invocation pattern

Source: `codex exec --help` on codex-cli 0.149.0 unless noted.

### Core shape

```
codex exec [OPTIONS] [PROMPT]
```

Prompt as argument, or `-` to read from stdin. **Gotcha (verified):** if a prompt argument is given *and* stdin is a pipe, stdin is read and appended as a `<stdin>` block ("Reading additional input from stdin..." observed). A daemon should either pass the prompt via `- < promptfile` or add `</dev/null` when using an argument.

### Model + effort

- `-m, --model <MODEL>` — model slug.
- `-c model_reasoning_effort=<v>` — config override. Docs (learn.chatgpt.com/docs/config-file/config-sample) list `minimal|low|medium|high|xhigh`, but the accepted set is **model-dependent and enforced server-side**: sending `minimal` with Luna fails (exit 1) with a 400 naming the real backend model and its accepted set — `"'minimal' is not supported with the 'gpt-5.6-luna-1p-codexswic-ev3' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'"` (measured). `none` works end-to-end (measured, exit 0).
- `-p, --profile <name>` layers `$CODEX_HOME/<name>.config.toml` on top of the base config — an alternative to a long flag list, but it *adds to* the user config rather than replacing it, so it does not remove MCP/plugins; not recommended for the watcher.

### Output capture

- **Plain mode (verified):** stdout carries *only* the final agent message. Everything else — banner (workdir/model/approval/sandbox/effort/session id), echoed prompt, warnings, `tokens used` line — goes to stderr. Matches the official non-interactive doc (learn.chatgpt.com/docs/non-interactive-mode: "stdout: Final agent message… stderr: Progress/status").
- `--json` (verified): JSONL events on stdout: `thread.started`, `turn.started`, `item.started`/`item.completed` (item types include `agent_message`, `error`, command executions), `turn.completed` with usage: `{"input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"}`, and `turn.failed`.
- `-o, --output-last-message <FILE>` (verified): writes the final message to a file; combines fine with plain or `--json` mode.
- `--output-schema <FILE>` (verified): JSON Schema constraining the final response. Used in all 13 benchmark runs; 13/13 outputs parsed as valid verdict JSON. (Plain-prompt runs without the schema also produced valid JSON on this trivial task, so the schema is belt-and-suspenders.)
- **Exit codes (measured):** 0 on success; 1 on failure (invalid model → HTTP 400; unsupported effort → HTTP 400). The 400 for an invalid model says only "The '<x>' model is not supported when using Codex with a ChatGPT account" — it does **not** enumerate valid models (measured; use `~/.codex/models_cache.json` for enumeration instead, see §2).

### Sandbox / approvals (read-only watcher)

- `-s read-only` — sandbox policy (`read-only | workspace-write | danger-full-access`). Verified: the run banner shows `sandbox: read-only`; in `exec` mode approval policy resolves to `never` even with `--ignore-user-config` (banner: `approval: never`), so nothing can block on a prompt.
- **Note:** read-only still lets the model *run read-only shell commands* — in the `-C` test it ran `ls` in the target repo (measured). Harmless for safety, but costs tokens/latency; a pure-classification watcher prompt should explicitly forbid tool use (with the prompt instruction "Do not run any commands", zero commands were run across all benchmark runs).
- `-C, --cd <DIR>` — verified working: invoked from `/tmp` with `-C /Users/johansardar/argus`, the agent's cwd was the repo. With `-C` pointing at a git repo, `--skip-git-repo-check` is unnecessary; keep it for non-repo dirs.
- `--skip-git-repo-check` — allows running outside a git repo (used in scratchpad runs).

### Suppressing startup overhead — what actually works (all verified on 0.149.0)

| Lever | Works? | Evidence |
|---|---|---|
| `--ignore-user-config` | **Yes — the main lever.** Drops user config.toml entirely: MCP servers (no more `expo` OAuth-refresh error), plugin hooks (no `hook: SessionStart` lines), the `notify` program (SkyComputerUseClient spawned per turn otherwise), `service_tier="priority"`, and the sol/ultra default. Auth still read from `CODEX_HOME`. | run2 vs run1 stderr; help text |
| `-c 'mcp_servers={}'` | **No.** Config overrides deep-merge; the empty table leaves all servers configured. Verified with `codex mcp list -c 'mcp_servers={}'` — identical 8-server list. Per-server `-c mcp_servers.<name>.enabled=false` is the documented granular form (config-sample doc shows `enabled` key). | measured; learn.chatgpt.com/docs/config-file/config-sample |
| `-c project_doc_max_bytes=0` | **Yes** for cwd AGENTS.md — behaviorally verified (a marker AGENTS.md saying "begin every reply with BANANA" was obeyed without the override, ignored with it). *Not separately verified* whether it also suppresses the global `~/.codex/AGENTS.md` (1.9 KB here). | measured (agents-test/) |
| Disabling skills | **No global switch found.** Docs only offer per-skill `[[skills.config]] path=… enabled=false` (learn.chatgpt.com/docs/build-skills). Skills load from `.agents/skills` (repo, walking up), `~/.agents/skills`, `/etc/codex/skills`, bundled system skills — and on this machine 9 hyperframes skills in `~/.codex/skills` still load even with `--ignore-user-config` (warning observed in every run). Bounded impact: the skills list is capped at "2% of the model's context window, or 8,000 characters" (docs). `codex features list` has no skills kill-switch (checked). | measured; docs |
| `--ephemeral` | Session files not persisted. Recommended: this machine already has 16.94 GB / 1,312 rollout files (`codex doctor`). Trade-off: nothing to `codex exec resume` later. | help; doctor output |

### Sessions / resume

`codex exec resume <id|--last>` and `codex exec fork` exist (help). With `--ephemeral` there is nothing to resume. If the Digest watcher ever wants a rolling session instead of stateless calls, drop `--ephemeral` and resume by session id (id is printed in the stderr banner and available as `thread.started.thread_id` in `--json`). Not benchmarked.

### `codex exec review` (Reviewer watcher)

`codex exec review [PROMPT]` runs a repo code review non-interactively with `--uncommitted` | `--base <BRANCH>` | `--commit <SHA>` scoping, `--title`, and the same lean flags (`--ignore-user-config`, `--ephemeral`, `--json`, `-o`, `--output-schema`, `-m`). Note it has **no `-s/--sandbox` and no `-C` flag** — the daemon must set cwd to the repo before invoking, and sandbox policy is not selectable on this subcommand (source: `codex exec review --help`). Not benchmarked.

---

## 2. Available models on this subscription (ChatGPT Pro)

Plan: `chatgpt_plan_type: "pro"` (verified from the `https://api.openai.com/auth` claim in `~/.codex/auth.json` id_token; no secrets reproduced here). Auth mode `chatgpt` (auth.json + `codex doctor`). Configured default in `~/.codex/config.toml`: `model = "gpt-5.6-sol"`, `model_reasoning_effort = "ultra"`, `service_tier = "priority"`.

Model enumeration source: `~/.codex/models_cache.json` (fetched by the CLI from the server, `fetched_at: 2026-08-24`, client 0.149.0) — this is the authoritative local list; an invalid `-m` error does *not* list models (measured).

| Slug | Description (verbatim) | Efforts (cache) | Notes |
|---|---|---|---|
| `gpt-5.6-sol` | "Latest frontier agentic coding model." | low…ultra (default low) | user's default; `ultra` = "Maximum reasoning with automatic task delegation" |
| `gpt-5.6-terra` | "Balanced agentic coding model for everyday work." | low…ultra | |
| `gpt-5.6-luna` | "Fast and affordable agentic coding model." | low…max (default medium); API also accepts `none` (measured) | **watcher pick** |
| `gpt-5.5` | "Frontier model for complex coding, research, and real-world work." | low…xhigh | |
| `gpt-5.4` | "Strong model for everyday coding." | low…xhigh | deprecation notice → terra |
| `gpt-5.4-mini` | "Small, fast, and cost-efficient model for simpler coding tasks." | low…xhigh | **deprecation notice (verbatim): "GPT-5.4 Mini will be deprecated soon — Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini."** Do not build on it. |
| `gpt-5.3-codex-spark` | "Ultra-fast coding model." | low…xhigh (default high) | cache says `supported_in_api: false`, but it **works via `codex exec` on this ChatGPT plan (measured)**; smaller prompt (14.1 K vs 18.1 K input) but always emitted reasoning tokens (78–195) on this task |
| `codex-auto-review` | "Automatic approval review model for Codex." | hidden (`visibility: hide`) | internal; not for the watcher |

---

## 3. Measured latency + token cost

Workload: watcher-shaped prompt — classify a 15-line fake agent-session transcript into `{"durable": bool, "kind": "fact"|"procedure"|"none", "summary": str}`. Full lean invocation (see Recommendation), `--output-schema` + `--json`, run sequentially on this machine (macOS, resident network) on 2026-08-24. Wall-clock is end-to-end process time (Python `perf_counter` around `subprocess.run`); usage from the `turn.completed` event.

**luna @ low (5 runs):** 5.91, 4.83, 5.33, 5.05, 5.48 s → **median 5.33 s**. input_tokens 18,119–18,192; cached 0 in these runs (other runs hit an 8,960-token cache intermittently); output 43–55; reasoning 0. 5/5 valid JSON.

**luna @ none (5 runs):** 5.13, 5.36, 5.87, 6.25, 5.32 s → median 5.36 s. Same token profile. No latency win over `low` — output is too small for reasoning suppression to matter; keep `low` for slightly better judgment headroom.

**spark @ low (3 runs):** 4.53, 5.59, 5.65 s → median 5.59 s. input 14,095 (2,176 cached); output 127–253 incl. 78–195 reasoning. Valid JSON 3/3. No net win.

**Comparisons (1 run each):** sol @ low, lean config: 7.26 s. sol @ ultra with the user's full default config (MCP + plugins + hooks + notify): 8.61 s, plus stderr noise: expo MCP OAuth-refresh ERROR, skills-budget warning, SessionStart hook lines. An early luna@low run *with* user config loaded: 6.56 s — so `--ignore-user-config` saves roughly 1–2 s and removes per-turn side effects (notify program spawn) and failure modes (MCP OAuth).

**Cost per call:** on the subscription there is no dollar metering; each call draws from the shared usage budget as roughly one small "local message": ~18.2 K input (≈9 K of it the cacheable system prompt; the CLI's stderr "tokens used" line ≈ input − cached + output, i.e. ~9.3–10 K when the cache hits) + ~50 output tokens. The ~18 K floor is the Codex system prompt + tool definitions + skills list; the watcher prompt itself was only a few hundred tokens, and `project_doc_max_bytes=0` keeps repo AGENTS.md files from inflating it further per-repo.

**Latency floor caveat:** ~5 s end-to-end is the realistic floor (CLI startup ≈1–1.5 s of user+sys time, plus network + model). This is fine for a debounced per-turn watcher, but it is not a sub-second primitive.

---

## 4. Rate limits / concurrency

- **Shared quota — verified from official pricing doc** (developers.openai.com/codex/pricing → learn.chatgpt.com/docs/pricing): all Codex surfaces share the same budget; the page's plan table covers CLI/IDE/cloud collectively. So `codex exec` watcher calls draw from the same pool as Johan's interactive Codex sessions. Plan is Pro (token claim); **which Pro multiplier tier (the docs table splits "Pro 5x" vs "Pro 20x") could not be determined from local files — unverified.**
- **Stated bands (doc's "estimated local messages" per 5-hour window, verbatim table values):** GPT-5.6 Luna: Plus 250–2,000; Pro 5x 1,250–10,000; Pro 20x 5,000–40,000. GPT-5.6 Sol: Plus 10–100; Pro 5x 50–500; Pro 20x 200–2,000. These are estimates, not hard call counts; the doc warns context-heavy tasks "use significantly more per message."
- **Watcher math (inference):** two watchers debounced per agent turn across several repos at, say, 60 calls/hour ≈ 300 calls/5 h of small luna messages — inside even the Plus luna band, with an order of magnitude of headroom on Pro. Sol-per-turn would *not* be safe on the lower bands.
- **Priority/fast tier:** the pricing doc says fast mode "consumes credits at a higher rate for supported models," and the user config pins `service_tier = "priority"` (the models cache labels that tier "Fast — 1.5x speed, increased usage"). `--ignore-user-config` drops it; the watcher should not inherit it.
- **Concurrency (measured):** 4 simultaneous `codex exec` luna calls all exited 0, no 429s, no observable serialization. No documented concurrency cap was found on the pricing or non-interactive pages (absence noted, not proven). **429/limit-reached behavior for exec was not observed or tested** — the doc only describes in-turn grace ("the agent will be able to continue working on that turn") for the limit boundary. The daemon should still treat nonzero exit + `turn.failed`/`error` events as retryable-with-backoff.

---

## Recommendation

**(a) Exact watcher invocation** (Reviewer/Digest, per-repo, read-only, machine-parseable):

```bash
codex exec \
  --ignore-user-config \
  -m gpt-5.6-luna -c model_reasoning_effort=low \
  -s read-only --ephemeral \
  -C "$REPO" --skip-git-repo-check \
  -c project_doc_max_bytes=0 \
  --output-schema "$SCHEMA_JSON" \
  --json \
  - < "$PROMPT_FILE"
```

Parse stdout JSONL: take `item.completed` where `item.type == "agent_message"` for the verdict, `turn.completed.usage` for metering, `turn.failed`/exit≠0 for retry. (Simpler alternative: drop `--json`, add `-o "$OUT_FILE"`, and read stdout or the file — plain stdout carries only the final message.) For the Reviewer specifically, also evaluate `codex exec review --uncommitted` / `--base` with the same lean flags (cwd must be the repo; no `-C` on that subcommand).

**(b) Model + effort:** `gpt-5.6-luna` at `model_reasoning_effort=low`. Rationale: cheapest non-deprecated model band (250–2,000 msgs/5h even on Plus), zero reasoning tokens on this workload, 100% schema-valid output, and effectively tied on latency with `none` and spark. `gpt-5.4-mini` is explicitly deprecated in favor of Luna; spark buys nothing here and is flagged `supported_in_api: false`.

**(c) Measured for that configuration:** median **5.33 s** wall-clock (5 runs, 4.83–5.91 s); **~18.15 K input tokens** (≈9 K cacheable; cache hits intermittent) + **~50 output tokens**, reasoning 0. Subscription-metered (no dollar cost); ≈ one small luna "local message" per call.

**(d) Limits/concurrency caveats:** shared quota with all Codex surfaces; Pro tier bands are 1,250–10,000 (5x) or 5,000–40,000 (20x) luna messages per 5 h — which Pro multiplier applies is **unverified**; 4-way concurrency measured clean; 429 behavior untested; never inherit `service_tier="priority"` (credit burn) — `--ignore-user-config` handles that.

**Verified vs. not:** Everything marked "measured/verified" above was reproduced on this machine today on codex-cli 0.149.0. Unverified/flagged: Pro 5x-vs-20x tier; exec-mode 429 semantics; whether `project_doc_max_bytes=0` also suppresses the global `~/.codex/AGENTS.md`; `service_tier` full enum; `codex exec review` and `resume` were inspected via `--help` but not benchmarked; pricing-table numbers are OpenAI's own estimates, not contractual counts. Version risk: flags and model slugs above are as of 0.149.0 (0.149.1 available) with visible churn in this area (docs domain migration, `gpt-5.4-mini` deprecation) — re-verify the model slug and bands before hard-coding.
