---
name: argus-orchestrator
description: Orchestrate Argus ticket deployment, provenance registration, cmux dispatch, worker monitoring, and green-ticket integration. Use when Hermes runs mission control for an Argus-enabled repository; do not use it to implement tickets.
---

# Argus Orchestrator

Act as the dispatcher. Never implement worker tickets. Follow `SPEC.md` §3, §5,
and §7; use this procedure for the operational details.

## Run every argus command from inside the repository

`argus` takes no `--repo` flag. Every verb — `dispatch`, `complete`, `signals`,
`status`, `grill` — finds its repository by walking up from the current working
directory, and refuses outright when there is none:

```
argus dispatch: current directory is not inside a git repository
```

So `cd` to the repository first and stay there. Orchestrating "the repo at
`<path>`" means running the commands *in* `<path>`.

And `--help` works ONLY at the top level. `argus --help` lists the commands;
`argus dispatch --help` does NOT print help — the flag is ignored and a real
dispatch pass runs, claiming tickets and spawning paid agent sessions. Never
probe a subcommand with `--help`.

## Preserve provenance before acting

Treat `.argus/registry/` as the only provenance authority.

1. Every deployed session gets a `.argus/registry/sessions.jsonl` row — session
   id, agent, ticket, full dispatch prompt, worktree, workspace and surface —
   fsynced BEFORE the session starts. `argus dispatch` writes that row itself, so
   do not write one by hand: you would double-log the session, and you could not
   write it correctly anyway, because a Codex session's id is minted by Codex at
   startup and announced on stdout. Your job is to dispatch through the command
   that guarantees this order, never to reproduce it.
2. Before every follow-up typed into any worker or Hermes session, append the send
   record to `.argus/registry/sends.jsonl`. Include the session id, agent, the
   workspace and surface **as UUIDs**, timestamp, kind, exact logical text intended
   to land, and the SHA-256 of its normalized UTF-8 content.

   **Never persist a short ref in a registry row** (#98/#99). This sentence used to
   say "prefixed workspace/surface refs" and #99 measured the result: a durable
   `"workspace":"workspace:1"` sitting in `sends.jsonl`. A registry row outlives the
   cmux process that minted the ref, refs are renumbered from scratch when cmux
   restarts, and a ref that resolves to nothing is not an error on 0.62.2 — it is a
   redirect onto whatever surface is focused. Copy the UUID out of
   `cmux --id-format both tree --all --json`; `sessions.jsonl` rows written by
   `argus dispatch` already hold UUIDs, so a follow-up can just carry the row's
   values through unchanged.
3. Normalize send content exactly as the matcher does: Unicode NFC; CRLF and CR to
   LF; trailing whitespace stripped from every line; then outer whitespace trimmed.
   Hash that exact result. Log the logical content, not Claude Code's transport
   continuation characters.
4. Only after the send record is durable, type the content. Never bypass the
   registry: an unlogged Hermes send is classified as Johan-authored and can poison
   `USER.md`.

## Send exactly one message at a time

For each logical message, issue one `cmux send`, submit it with one Enter, and verify
that it landed before sending anything else. Never leave text unsubmitted and never
allow consecutive sends to merge.

- For Claude Code, encode every interior newline as backslash plus a real LF so the
  continuation lands as one message.
- For Codex, send interior newlines as raw LF. Do not add Claude's continuation
  backslash.
- If content contains the literal two-character sequences `\n`, `\r`, or `\t`,
  split it into separately logged logical messages so no `cmux send` argument
  contains one of those sequences. Do not attempt to escape them through cmux.
- Log and hash the intended logical content after the normalization above, never the
  transport encoding.

If a non-command send does not land, surface an audit event and notify; never silently
discard the unmatched registry entry — log a second row for the retry rather than
reusing the first.

There is no `argus resume`. A Codex worker dispatched with `codex exec` is a
one-shot process, so once it exits its registry session has no live surface to
send to, and following up means rebuilding the worker's environment by hand.
When you do, carry `CODEX_HOME`, `HERMES_HOME` and the worktree path over
deliberately: a resume launched under the wrong `CODEX_HOME` looks like a send
that did not land, and you will debug the wrong layer.

## Keep cmux headless and attachable

**Never create a cmux workspace.** A deployed session is a TAB, not a workspace
(#95, SPEC §7.2/§7.3). `argus dispatch` opens it for you with `cmux new-surface`
in the workspace Argus is already running in — the one named by
`CMUX_WORKSPACE_ID` — names it `argus #<ticket>`, records its surface id in the
session's registry row, and closes it with `cmux close-surface` when the session
is reaped. Argus creates ZERO workspaces, and neither do you: `cmux
new-workspace` is not part of any Argus procedure. Outside cmux there is no
`CMUX_WORKSPACE_ID`, and the deployment simply proceeds without a tab — a
workspace is context, never a requirement.

The addressable unit for a session is a SURFACE, not a pane. Typed prefixed refs
(`workspace:1`, `surface:60`) and raw UUIDs both resolve — Argus uses UUIDs
internally because `CMUX_WORKSPACE_ID` is one — but they are NOT equally safe.
cmux also accepts a bare INDEX in the same flag, and it is a third thing again:
`--workspace 1` is positional and resolved to a different workspace than
`--workspace workspace:1` when #90 measured it. Never drop the prefix.

**Never pass a short ref to `close-surface`.** #90 measured why against the
real 0.62.2 binary, and the reason is NOT the one this skill gave until then.
Short refs do not remap: they come from a monotonic counter, they survive
`reorder-surface`, and a closed surface's ref is never handed to a new one
(`surface:64` closed, next tab got `surface:66`). What actually kills you is
that a ref which resolves to NOTHING — freed by an earlier close, or minted by
a previous cmux process — **fails open**:

```
cmux list-pane-surfaces --workspace workspace:9999   -> exit 0, answers for the FOCUSED workspace
cmux list-pane-surfaces --workspace 00000000-...     -> exit 1, "not_found: Pane or workspace not found"
cmux close-surface --surface 00000000-... --workspace 00000000-...  -> exit 1, closes nothing
```

An unresolvable **short ref** exits 0 and acts on the focused workspace. An
unresolvable **UUID** errors and acts on nothing. That is the whole argument:
a UUID handle fails CLOSED, so a destructive verb pointed at a dead UUID is a
no-op, while the same verb pointed at a dead ref destroys whatever Johan is
looking at. Refs are also renumbered from scratch when cmux restarts, so a ref
persisted in a registry row outlives the process that gave it meaning.

So: **hold the UUID from `cmux --id-format both tree --all --json` and pass a
UUID to anything that destroys state.** Re-resolving first is good practice but
it is not the protection — resolve-then-act is not atomic, and the UUID is what
makes the gap harmless. Read-only verbs may use whatever ref is convenient.

Argus itself no longer relies on you remembering this (#98). `runCmux` is the
only place in the tree that spawns `cmux`, and it REFUSES any state-changing
verb — the three `close-*`, `new-surface`/`new-pane`/`new-split`, every
`rename-*`, `move-*`, `reorder-*`, `focus-*`, `select-workspace`, `tab-action`,
`workspace-action` — whose `--workspace`/`--surface`/`--pane`/`--window`/
`--tab`/`--panel` value is not a raw UUID. It refuses without spawning, exit 1
with the reason on stderr. `send`/`send-key` are deliberately exempt: their
redirect costs a stray line rather than a terminal, and they are already
guarded by resolution. **This does not cover cmux commands YOU type** — you are
outside that process, so the rule above is still yours to keep.

`list-workspaces` sees only the current window and will miss the workspace
Argus runs in; `tree --all` is the only whole-machine inventory. Never steal
focus — `cmux identify` shows `focused` moving on its own while other sessions
work, so "I checked what was focused" is never a safety argument.

Report worker state with `cmux set-status`, batch state with `cmux set-progress`, and
blocking events with `cmux notify`. Open digests and ticket context beside mission
control with `cmux markdown open`.

Expect Johan to attach to any worker at any time. Continue normally: unexpected user
input is not a worker error. Registry matching classifies it, and the Retro watcher
makes uncovered implementation safe as specified in §5 and §7.5.

## Open a grill session when Johan asks to be grilled

"Grill X for repo R" is SPEC §7.2, and it is a command, not a procedure to
improvise: run `argus grill "<X>" --ticket <n>` from repo R, where `<n>` is the
owning GitHub ticket. Do not create the workspace,
write the session row, or type the `claude` line yourself — the command does
all three in the order §5 rule 1 requires, and doing it by hand is how an
unregistered prompt lands and classifies as Johan.

- Route by what Johan is asking for: `--mode grilling` (the default) to be
  grilled, then `--mode spec`, `--mode tickets` for the rest of the §7.1 chain,
  and `--mode review` / `--mode diagnosis` for those labels. Every mode routes
  to Claude Code, per §1's table.
- Use `--dry-run` first when the topic is ambiguous. It prints the routed skill
  and the exact opening prompt and starts nothing.
- The command prints the cmux workspace ref and sends Johan a `cmux notify`.
  Tell him the ref as well: the notification is best-effort and a failed one
  degrades rather than stopping the session.
- A grill session names its owning ticket. §7.5 exempts the session from
  implementation-scope enforcement only; registration, ticketing, and lifecycle
  monitoring still apply. Do not put it on the dispatch frontier.
- It runs in repo R's own checkout, not a worktree, so its spec and tickets are
  not stranded on a branch nobody merges.
- Follow-ups into a live grill go through the same logged send protocol as any
  worker. Never type into a grill session outside the registry.
- If the command refuses because cmux would not give it a resolved workspace,
  that is not something to work around by launching `claude` yourself. §7.2 is
  a session Johan attaches to, and a handle cmux does not resolve types into
  whatever workspace is focused.

## Dispatch the frontier

Run `argus dispatch` from inside the repository. One pass, and it is a command,
not a procedure to improvise — the same rule the grill section states, for the
same reason. In one fail-closed sequence it:

1. reads the frontier from GitHub — tickets open, unblocked, unclaimed, and
   without open sub-issues;
2. recovers dead sessions first, freeing their slots and closing their tabs,
   because a dead session's slot is capacity this pass may need;
3. claims each ticket by assigning it, before any deployment;
4. cuts a dedicated git worktree on the ticket's own branch;
5. routes the agent — `grilling`, `spec`, `review` and `diagnosis` labels to
   Claude Code, everything else to Codex by default, with an explicit
   `agent:claude-code` or `agent:codex` label overriding;
6. writes the complete `sessions.jsonl` record and fsyncs it, THEN spawns the
   agent, THEN opens and names its tab;
7. stops at the concurrency cap in `.argus/config.yaml` (`3` when absent),
   accounted through durable slots.

Do not hand-build this loop. You cannot reproduce its ordering guarantees from
outside: the slot accounting is durable and racy to imitate, and a Codex
session's id does not exist until Codex announces it on stdout, so the registry
row you were about to write by hand cannot be written at the moment the
provenance rule requires it. `argus dispatch` scans for that announcement and is
the only thing that can.

Read what it printed. A degraded pass exits non-zero and says why; the tickets
it held back are named with the reason. Then monitor events and digests, and let
`argus complete` own every GitHub state transition — never merge or close a
ticket yourself, and never assume a worker closed its own.

## Close finished tickets

Run `argus complete` for the repository. One pass consumes this sweep's terminal
signals, then verifies every ticket awaiting verification: gates run in the ticket's
own worktree, the review reads the diff measured from `git merge-base`, and only a
green pass merges into the base branch, closes the ticket as completed, and adds one
line to the `wayfinder:map` issue.

The pass refuses on purpose, and a refusal is not a failure to work around:

- a red gate, a blocking review, or a review that could not run leaves the ticket open
  and claimed, with the reason commented on the ticket;
- a `blocked-on-human` signal never merges—attach and answer it;
- a session that died rather than finished belongs to `argus dispatch`'s recovery pass,
  which decides whether it left work behind;
- a wrong-branch or dirty checkout stops the merge until the checkout is clean.

Refused tickets stay on the durable queue under `.argus/dispatch/verify/` and are
retried by the next pass, because the completion signal that raised them is spent.
Never merge or close a ticket by hand to get around a refusal; fix what the gate found.

`argus up` installs a repo-scoped Hermes cron job that runs `argus signals` every five
minutes. The command emits only unseen terminal prompts and stays silent on an empty
sweep. Running `argus signals` yourself is safe and often the right move when you
want the current sweep now rather than in five minutes — push and poll share one
durable consumer cursor, so a signal is delivered once no matter who asks. What
you must not do is install a SECOND poll job, or re-inject a signal you have
already consumed by hand; both defeat the cursor.

## Launch and observe Hermes

`argus up` creates a repo-scoped Hermes profile INSIDE the Hermes home, at
`$HERMES_HOME/profiles/argus-<repo-slug>-<16 hex of the repo path digest>`, and
registers the repo's `.argus/skills` in that profile's `config.yaml`. The
profile is a directory under the home — it is not itself a `HERMES_HOME`, and
pointing `HERMES_HOME` at it makes Hermes look for `profiles/` inside the
profile. Read the profile name rather than guessing it; the digest is not
reconstructable by eye:

```sh
hermes profile list
```

Before #102 that listing was empty of Argus profiles and `hermes profile use`
refused them: the generated name ran past Hermes' 64-character limit
(`^[a-z0-9][a-z0-9_-]{0,63}$`), so every profile `argus up` wrote was inert.
If you are on an older checkout, or `list` does not show the profile you
expect, check the name length before anything else — and note that
`hermes profile show` and `describe` will happily succeed on a name that
`use` refuses, so neither is a usability check.

To drive a batch unattended, run Hermes headless with this skill selected:

```sh
hermes -z "<the mission>" -s argus-orchestrator
```

Do not switch the machine-wide active Hermes profile. Receive completion and blocked
events as files under `.argus/events/`; notify Hermes with a one-line `cmux send` to
its mission-control workspace through the same registry-first send protocol.

Zoom into work in this order: `argus status` for the eyes and any outstanding
audits, then `.argus/sessions/INDEX.md`, then the selected session digest, then
`argus search "<query>"`. Keep routine monitoring at the lowest useful resolution.

Watch `.argus/events/` as well as the tickets. A `blocked-on-human` worker writes
its reason to an event file, and since #104 `argus complete` also comments that
reason on the ticket — once per block, not once per pass — so a block is visible
where you already look. The ticket still stays open and claimed, and nothing
resumes it on its own. If a block ever reaches the report as `degraded` saying
the comment could not be posted, the tracker IS silent about that one and the
reason is only in `.argus/events/`.

If the same ticket blocks for the same reason on consecutive passes,
stop redeploying it: the next `argus dispatch` will recover the dead session and
deploy it again, and it will fail the same way, at the cost of a fresh agent
session each pass. Answer the block instead, or say plainly that it needs Johan.
