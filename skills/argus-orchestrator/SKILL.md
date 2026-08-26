---
name: argus-orchestrator
description: Orchestrate Argus ticket deployment, provenance registration, cmux dispatch, worker monitoring, and green-ticket integration. Use when Hermes runs mission control for an Argus-enabled repository; do not use it to implement tickets.
---

# Argus Orchestrator

Act as the dispatcher. Never implement worker tickets. Follow `SPEC.md` §3, §5,
and §7; use this procedure for the operational details.

## Preserve provenance before acting

Treat `.argus/registry/` as the only provenance authority.

1. Before starting any deployed session, append its session id, agent, ticket, full
   dispatch prompt, and prefixed cmux workspace ref to
   `.argus/registry/sessions.jsonl`. Do not start the session until the record is
   durable.
2. Before every follow-up typed into any worker or Hermes session, append the send
   record to `.argus/registry/sends.jsonl`. Include the session id, agent, prefixed
   workspace/surface refs, timestamp, kind, exact logical text intended to land, and
   the SHA-256 of its normalized UTF-8 content.
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
discard the unmatched registry entry.

## Keep cmux headless and attachable

Create one workspace per deployed session. Name it `<repo>/<ticket-or-purpose>` and
set `--cwd` to the repository or that ticket's worktree. Always use typed, prefixed
refs such as `workspace:15` and `pane:38`. Pass `--focus false` on every programmatic
action and never steal focus.

Report worker state with `cmux set-status`, batch state with `cmux set-progress`, and
blocking events with `cmux notify`. Open digests and ticket context beside mission
control with `cmux markdown open`.

Expect Johan to attach to any worker at any time. Continue normally: unexpected user
input is not a worker error. Registry matching classifies it, and the Retro watcher
makes uncovered implementation safe as specified in §5 and §7.5.

## Open a grill session when Johan asks to be grilled

"Grill X for repo R" is SPEC §7.2, and it is a command, not a procedure to
improvise: run `argus grill "<X>"` from repo R. Do not create the workspace,
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
- A grill session has NO ticket, on purpose (§7.5 exempts planning). Do not
  invent one for it, and do not put it on the dispatch frontier.
- It runs in repo R's own checkout, not a worktree, so its spec and tickets are
  not stranded on a branch nobody merges.
- Follow-ups into a live grill go through the same logged send protocol as any
  worker. Never type into a grill session outside the registry.
- If the command refuses because cmux would not give it a resolved workspace,
  that is not something to work around by launching `claude` yourself. §7.2 is
  a session Johan attaches to, and a handle cmux does not resolve types into
  whatever workspace is focused.

## Dispatch the frontier

Repeat this loop up to the concurrency cap in `.argus/config.yaml`; use `3` when the
cap is absent.

1. Read GitHub for the current frontier: tickets that are open, unblocked, and
   unclaimed.
2. Claim one ticket by assigning it before deployment.
3. Create a dedicated git worktree and a new cmux workspace rooted at that worktree.
   Use one fresh worker session for exactly one ticket.
4. Route `grilling`, `spec`, `review`, and `diagnosis` labels to Claude Code. Route all
   other tickets to Codex by default. Let explicit `agent:claude-code` or
   `agent:codex` labels override the default.
5. Allocate the deployment session id, write the complete `sessions.jsonl` record,
   then launch the routed agent and deliver the full dispatch prompt using the logged
   send protocol.
6. Monitor events and digests. On green—tests pass and review is clean—merge the
   ticket branch from its worktree, close the ticket, and update the wayfinder map.
   Own these GitHub state transitions; never assume the worker closed its ticket.

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
sweep. Do not create a second poll job or manually replay a signal: push and poll share
the durable consumer cursor specifically to prevent double delivery.

## Launch and observe Hermes

Run Hermes for an Argus repository with a repo-scoped profile:

```sh
HERMES_HOME="$HOME/.hermes/profiles/argus-<slug>" hermes chat
```

Do not switch the machine-wide active Hermes profile. Receive completion and blocked
events as files under `.argus/events/`; notify Hermes with a one-line `cmux send` to
its mission-control workspace through the same registry-first send protocol.

Zoom into work in this order: `.argus/sessions/INDEX.md`, then the selected session
digest, then `argus search "<query>"`. Keep routine monitoring at the lowest useful
resolution.
