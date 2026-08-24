# Send↔transcript matching scheme

Research findings for ticket [#11](https://github.com/JohanSardar/argus/issues/11)
(SPEC.md §5, §11.9). Date: 2026-08-24. Question: Hermes logs every message it types
into a worker session to `registry/sends.jsonl` before sending it via `cmux send`;
watchers must reliably match each entry to the corresponding user-side transcript
message, because any unmatched user message is classified Johan-authored. What is the
matching rule — normalization, hash, timestamp window, tie-break?

**Sources.** Direct experiment, 2026-08-24, this machine: cmux 0.62.2 (77)
[6c203b514], Claude Code 2.1.241, codex-cli 0.149.0, macOS (Darwin 25.5.0). Two
scratch cmux workspaces (created and destroyed for the occasion), one live Claude Code
session (Haiku 4.5, session `440888d4-8455-4fa7-8c43-4d319e998019`, 193 transcript
lines) and one live Codex session (thread `01a034fe-43c8-74e3-a81c-0fb7bf47ed27`
plus one auto-spawned subagent thread). ~34 instrumented sends total: for every send,
the exact argv bytes and `time.time_ns()` before/after the `cmux send` and
`cmux send-key enter` calls were logged, then the landed transcript record was diffed
byte-for-byte against the sent bytes. Codex rollout parsing follows the #5 findings
([codex-rollout-attribution.md](codex-rollout-attribution.md)).

---

## TL;DR — the matching rule

1. **Hermes protocol:** one logical message per `cmux send` + Enter; log the entry
   (normalized-content SHA-256 + wall-clock timestamp) *before* sending; verify the
   landing before the next send. Newlines are encoded per agent (§1.3): Claude Code
   needs `\`+LF continuation, Codex takes raw LF.
2. **Normalization** (applied to both the send text and the transcript text):
   NFC → CR/CRLF→LF → strip trailing whitespace per line → trim outer whitespace.
   Hash = SHA-256 of the UTF-8 bytes of the result. Under this normalization every
   experiment's send hash equals its transcript hash, including a 1,426-char payload.
3. **Window:** transcript timestamp ∈ [send_ts − 5 s, send_ts + 3600 s]. Direct
   landings measured 0.10–3.10 s after submit; Claude Code *queued* landings are
   stamped at dequeue (observed up to +5.9 s, unbounded by a long turn) — the
   `queue-operation` enqueue record (content + near-send timestamp) bridges them.
4. **Consumption:** one send matches at most one user message; oldest unconsumed
   matching send wins; a consumed send never matches again.
5. **Tie-break:** any user message whose normalized hash equals an unconsumed
   registry send in-window is **Hermes-authored** — ambiguity always resolves toward
   Hermes, because a false-Johan poisons `USER.md` permanently while a false-Hermes
   only delays one fact (§6). Unmatched user message → Johan. Unmatched send after
   window expiry → loud audit event, never silence.

Full rule in §7.

---

## 1. How `cmux send` text lands

### 1.1 Submit semantics

`cmux send <text>` types into the target surface's input box and does **not**
submit (verified on both TUIs: the text sat in the composer). Submit happens via a
trailing `\n`/`\r` escape in the argument or a separate `cmux send-key enter`. A
`sends.jsonl` entry therefore corresponds to one *send + submit* pair, and Hermes'
adapter must always pair them; an unsubmitted send sits invisibly in the composer and
prepends itself to whatever is typed next (a merge hazard, §1.4).

### 1.2 cmux's escape layer mutates content

The CLI documents `\n`/`\r` → Enter and `\t` → Tab. Observed behavior is a naive
substring substitution with **no escape for backslash itself**, and a real LF byte
(0x0A) in the argument is also delivered as an Enter keypress:

- arg `a` `\` `\` `n` `b` (literal backslash-backslash-n): cmux replaced the
  `\n` substring, typing `a` `\` Enter `b` — on Claude Code the `\`+Enter became a
  line continuation and the message landed as `a<LF>b`.
- arg with real LFs (`line one<LF>line two`): delivered as Enter keypresses.

Consequence: content containing the two-character sequences `\n`, `\r`, `\t` — e.g.
code snippets — **cannot pass through a single `cmux send` argument unmutated**.
Hermes' adapter must split such content across multiple send calls so no argument
contains those sequences, and must log the logical text as it is meant to land.

### 1.3 Newline landing differs per agent

| Payload | Claude Code | Codex |
| --- | --- | --- |
| `E2 line one<LF>E2 line two   <LF>E2 line three` | **splits into 3 user messages**: line one submits immediately (`promptSource:"typed"`), lines two and three land as separate `"queued"` messages | **one message**, newlines and interior trailing spaces preserved byte-for-byte |
| `line1` `\`+LF `line2` (backslash continuation) | **one message** `line1<LF>line2`, backslash consumed | one message `line1\<LF>line2` — **backslash kept as a literal character** |

So a multi-line logical message needs per-agent encoding: Claude Code → replace each
interior LF with `\`+LF; Codex → raw LF. Getting this wrong on Claude Code shatters
one logical send into N transcript messages, none of which matches the logged hash.

### 1.4 Rapid successive sends merge

Two `cmux send` calls back-to-back followed by one Enter landed as **one** user
message that is the exact concatenation of the two payloads (`'E6 part one.'` +
`' E6 part two.'` → `'E6 part one. E6 part two.'`, both agents). No normalization can
recover per-send identity from a merged landing, so this is a protocol constraint,
not a matcher feature: one logical message per send+submit, verify the landing
(transcript tail or `read-screen`) before the next send.

### 1.5 Whitespace and unicode mutations

Verified byte-level, per agent:

| Mutation | Claude Code | Codex |
| --- | --- | --- |
| Trailing whitespace of message | stripped (`'…spaces   '` → `'…spaces'`) | stripped |
| Leading whitespace of message | **preserved** (`'   E4 …'`) | stripped (full trim) |
| Interior whitespace/newlines | n/a (splits lines) — preserved via continuation | preserved (incl. `'line two   <LF>'`) |
| Trailing real LF | becomes the submit keypress; never part of content | same |
| Unicode NFD input (`e`+U+0301, sent verified-NFD) | landed **NFC** | landed **NFC** |
| 1,426-char single line, quotes/braces/angle brackets | byte-exact (sha256 equal) | byte-exact |
| Paste-collapse (`[Pasted text #N]`) | not observed — display-only; JSONL stores full text | not observed |
| Chunking/truncation | none | none |

NFC normalization happens somewhere in the cmux → PTY → TUI pipeline on both agents
(guaranteed-NFD probe `E3c` landed precomposed in both transcripts), so the matcher
must NFC-normalize both sides.

---

## 2. Transcript record anatomy (what the matcher reads)

### 2.1 Claude Code (`~/.claude/projects/<slug>/<session>.jsonl`)

A Hermes-typed message lands as one line:

```json
{"type":"user", "message":{"role":"user","content":"E0 submit semantics probe"},
 "timestamp":"2026-08-24T17:49:59.470Z", "promptSource":"typed",
 "origin":{"kind":"human"}, "userType":"external", "entrypoint":"cli",
 "uuid":"…", "parentUuid":null, "sessionId":"…", "cwd":"…", "isSidechain":false, …}
```

**`origin.kind` is `"human"` and `promptSource` is `"typed"` for cmux-typed text** —
the transcript alone cannot distinguish Hermes from Johan; only the registry can.
Candidate user messages for provenance classification are exactly:

- `type == "user"`, `message.content` is a **string**, `isMeta` absent/false,
  `isSidechain` false, `promptSource` ∈ {`"typed"`, `"queued"`} — a real prompt.
- Skip: array-content user records (tool_results and skill payloads), `isMeta:true`
  records, `attachment`/`system`/`queue-operation`/every other line type.
- Special shapes (§2.3): `<bash-input>…`, `<command-name>…` records.

Queued path: a submit while a turn is running writes
`{"type":"queue-operation","operation":"enqueue","timestamp":…,"content":"…"}`
at ~send time; at turn end a `dequeue` record and then the real user record
(`promptSource:"queued"`) appear, **timestamped at dequeue**, one user record per
queued line, in order. The enqueue record carries the (already trailing-stripped)
content — it is the matcher's timestamp bridge for late dequeues.

### 2.2 Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)

At 0.149, user text appears in exactly one line type:
`response_item` with `payload.type=="message"`, `payload.role=="user"`,
`payload.content == [{"type":"input_text","text":"…"}]`; the envelope `timestamp` is
written when the message is injected into a turn. No `event_msg`/`user_message`
lines were produced, and no `item_completed` duplicates of user messages exist in the
thread file. Skip synthetic user-role items: text starting `# AGENTS.md
instructions`, `<user_instructions>`, `<environment_context>`, `<ide_context>` (the
#5 findings' skip list).

**Subagent duplication hazard:** the session auto-spawned a subagent thread
(`source: {"subagent": {"thread_spawn": {"parent_thread_id": …}}}`) whose rollout
contains **byte-identical copies of the parent's user messages with identical
timestamps**. A naive matcher would see the same send land twice and burn two
registry entries — or classify the copy as Johan. Match only against the parent
thread; treat subagent/forked threads (identified per #5 §4) as non-candidate for
provenance, inheriting the parent's classification.

### 2.3 Slash and bang sends (Claude Code)

| Send | Transcript result |
| --- | --- |
| `/help` | **no record at all** (local command) |
| `/cost` | no record, and it opens a modal panel that **swallowed the next send** until Esc |
| `/caveman hello there` (skill command) | user record, string content `<command-message>caveman</command-message>\n<command-name>/caveman</command-name>\n<command-args>hello there</command-args>`, plus an `isMeta:true` array-content companion (skip) |
| `!echo hermes-bang-probe` | two user records: `<bash-input>echo hermes-bang-probe</bash-input>` then `<bash-stdout>…</bash-stdout><bash-stderr></bash-stderr>`; the `!` is dropped, `promptSource` absent |

Matcher handling: for a send starting with `/name args`, also accept the derived form
`<command-message>…</command-message>\n<command-name>/name</command-name>\n<command-args>args</command-args>`
(and zero landings as benign); for a send starting with `!cmd`, accept
`<bash-input>cmd</bash-input>`; never classify `<bash-stdout>`/`<bash-stderr>`
records as authored messages at all.

---

## 3. Timestamp semantics and the window

All timestamps are ISO-8601 UTC with millisecond resolution, written by the same
machine that runs Hermes and the workers — no cross-host clock skew. `sends.jsonl`
timestamps are taken *before* the send (SPEC §5), so transcript − send is
non-negative modulo scheduler noise.

Measured latency, transcript timestamp minus Enter-keypress wall clock:

| Case | n | Range |
| --- | --- | --- |
| Claude Code, typed (idle submit) | 11 | +0.10 s … +1.34 s |
| Claude Code, queued (submit mid-turn) | 7 | +0.49 s … +5.9 s after *enqueue*; user record stamped at **dequeue = turn end**, so unbounded under a long turn. Enqueue record lands +≈0.1 s after send. |
| Codex, idle submit | 12 | +0.32 s … +3.10 s (the +3.1 s outlier was the 1,426-char payload) |
| Codex, submit mid-turn | 2 | +0.32 s, +0.34 s — steering is injected into the running turn immediately; no dequeue delay exists |

Window choice: **[send_ts − 5 s, send_ts + 3600 s]**.

- Lower bound −5 s: pure defensive margin for scheduler jitter; nothing negative was
  observed.
- Upper bound: direct landings need ≤ ~30 s even with 10× margin, but Claude Code
  queued landings inherit the running turn's duration. Rather than a per-case window,
  one generous bound covers both; the cost of width is only the identical-content
  ambiguity, which the tie-break already resolves toward Hermes and consumption
  (§7) makes rare. Claude Code's enqueue record additionally binds a queued send
  within seconds, letting the matcher consume the eventual dequeued record even past
  the window (§7 step 4).

---

## 4. Failure modes and provenance consequences

False-**Johan** = Hermes text classified Johan-authored → written into `USER.md`,
silently and durably poisoning the highest-trust file (SPEC §5.1: `USER.md` only
from registry-verified Johan messages). False-**Hermes** = Johan text classified
Hermes-authored → one Johan fact missed by `USER.md`; the text still reaches the
archive, digest (`johan_touched` may lag), and can be re-learned when Johan repeats
it. The costs are asymmetric: poison is permanent and invisible, a miss is
recoverable. **Every ambiguity therefore breaks toward Hermes-authored.**

| Failure mode | Cause | Consequence if unhandled | Handling |
| --- | --- | --- | --- |
| Unlogged send (SPEC §13 scenario 5) | bug/bypass in Hermes | false-Johan — worst case | non-negotiable log-before-send; simulation asserts visibility |
| Send never lands | session died, modal panel (observed: `/cost` panel ate the next send), composer left unsubmitted | stale registry entry | after window expiry with no match: audit event + `cmux notify`; never silently drop |
| Multi-line send to Claude Code without continuation encoding | §1.3 | N transcript messages, none matches → N false-Johans | per-agent newline encoding; matcher flags a hash-miss that is a prefix-line of a pending send as an encoding bug |
| Two sends merged (§1.4) | protocol violation | merged message matches nothing → false-Johan | one message per send+submit, verify landing before next send |
| Johan types text identical to a pending send | coincidence ("continue", "yes") | Johan's message consumed as Hermes → false-Hermes | accepted by design: tie-break toward Hermes; consumption means only ONE landing is absorbed and Hermes' own landing then correctly falls to Johan — net one miss, zero poison |
| Slash command send | §2.3 | zero or XML-shaped landing → stale entry or hash-miss | derived-form matching; zero-landing slash sends expire benignly |
| Bang command send | §2.3 | `<bash-input>` shape never hash-matches | derived-form matching |
| Codex subagent copies (§2.2) | thread spawn duplicates messages | double consumption or false-Johan on the copy | match parent threads only |
| Clock skew | none — single machine | — | −5 s guard suffices |
| cmux escape-layer mutation of `\n`-bearing content (§1.2) | naive substitution | landed text ≠ logged text → false-Johan | adapter splits sends around `\n`/`\r`/`\t` sequences; logs logical text |

---

## 5. What Hermes must write to `sends.jsonl`

One entry per logical message, written before the send:

```json
{"ts": "2026-08-24T18:12:16.171Z",          // wall clock immediately before cmux send
 "session_id": "<registry session id>",      // binds to sessions.jsonl
 "agent": "claude|codex|hermes",
 "workspace": "workspace:15", "surface": "surface:80",
 "text": "<the logical message exactly as it should land as ONE user message>",
 "sha256": "<hex sha256 of normalize(text)>",// precomputed; matcher recomputes to verify
 "kind": "prompt|slash|bang"}                // slash/bang get derived-form matching
```

Adapter contract backing the entry (all from §1): pair every send with exactly one
submit; encode interior newlines per agent (Claude `\`+LF, Codex raw LF); split
around literal `\n`/`\r`/`\t` character sequences; never send while a previous send
is unverified or a modal panel is open.

---

## 6. Tie-break direction, stated

If a user-side transcript message hash-matches any unconsumed registry send inside
the window, it is **Hermes-authored**, unconditionally — even though a coincidentally
identical Johan message would be mislabeled. Justification: SPEC §5.1 makes `USER.md`
purity the binding constraint; the poisoning direction (false-Johan) is irreversible
and self-concealing, while the miss direction (false-Hermes) is bounded to one
message, leaves the archive/digest intact, and self-heals when the preference is
restated. The registry is the single source of truth precisely so that the expensive
error is structurally impossible whenever Hermes follows protocol.

---

## 7. The matching rule (implementable)

Normalization — apply to *both* the `sends.jsonl` `text` and every candidate
transcript message, in order:

```
normalize(s):
  s = unicodedata.normalize("NFC", s)      # observed: pipeline NFC-normalizes NFD input (both agents)
  s = s.replace("\r\n", "\n").replace("\r", "\n")   # defensive; CR cannot land as content
  s = "\n".join(line.rstrip() for line in s.split("\n"))  # observed: trailing-space strip (Claude per line/message)
  s = s.strip()                            # observed: Codex trims both ends, Claude trims trailing
  return s

hash(s) = sha256(normalize(s).encode("utf-8"))
```

Every experiment in §1.5 hashes equal under this normalization; no step beyond these
four was needed, and none can be dropped (NFC: E3c; LF: encoding differences; per-line
rstrip: E2a; outer strip: E4 on both agents).

Matcher, per repo, consuming the shared tailer's event stream:

```
state: pending = ordered list of unconsumed sends.jsonl entries (per session)

candidate(msg):                       # per §2.1 / §2.2
  claude: type=="user" && content is string && !isMeta && !isSidechain
  codex:  response_item message role=="user", non-synthetic, parent threads only

derived_forms(send):                  # §2.3
  kind==prompt → [normalize(text)]
  kind==slash  → [normalize(text), command_xml_form(text)]   # zero landings allowed
  kind==bang   → ["<bash-input>" + normalize(text[1:]) + "</bash-input>"]

on user message m in session S at transcript time T:
  for send in pending[S] oldest-first:
    if hash(m) in hashes(derived_forms(send))
       and T >= send.ts - 5s
       and (T <= send.ts + 3600s  or  send.enqueue_seen):   # queue bridge, below
      consume(send); classify m HERMES; return
  classify m JOHAN                                           # unmatched → Johan

on claude queue-operation enqueue e in S:                    # timestamp bridge
  if some send in pending[S] has hash(e.content) in its forms
     and e.ts within [send.ts - 5s, send.ts + 30s]:
    send.enqueue_seen = true          # its dequeued user record may land arbitrarily late

on send entry expiry (now > send.ts + 3600s, not consumed, no enqueue_seen):
  if send.kind == slash: retire silently                     # zero-landing is normal
  else: emit audit event + cmux notify                       # visible, never silent (§13.5)
```

Properties: one send consumes at most one message (merge bugs surface as audit
events, not misclassification); identical repeated sends ("continue" × 3) resolve in
order because consumption is oldest-first; everything unmatched is Johan — which is
exactly the SPEC's stated default — and everything ambiguous is Hermes, which is the
direction §6 argues the system must fail.

---

## Appendix: raw evidence

- Claude Code transcript: `~/.claude/projects/-private-tmp-claude-501--Users-johansardar-argus-69ff405f-6d62-4054-8651-21a18530ba5e-scratchpad-t11-ws-claude/440888d4-8455-4fa7-8c43-4d319e998019.jsonl` (193 lines; experiments E0–E10, E3b/E3c, E8a–E8d, E9).
- Codex rollouts: `~/.codex/sessions/2026/08/24/rollout-2026-08-24T13-17-53-01a034fe-43c8-74e3-a81c-0fb7bf47ed27.jsonl` (main thread, E0–E11) and `…13-18-31-01a034fe-d6ae-….jsonl` (auto-spawned subagent showing the duplication hazard).
- Send logs with ns timestamps and exact argv bytes were kept in the session
  scratchpad (`…/scratchpad/t11/evidence/{claude,codex}-sendlog.jsonl`); the latency
  tables in §3 are computed from them against the transcript timestamps above.
- Byte-equality checks: 1,426-char payload sha256 `cf2e9071db6fd14b…` equal on both
  agents; NFD probe `E3c` verified `is_normalized("NFD")` at send and
  `is_normalized("NFC")` in both transcripts.
