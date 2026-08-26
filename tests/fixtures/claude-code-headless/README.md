# Real headless Claude Code transcript lines (ticket #50)

Every line in this directory is **verbatim bytes from a real transcript** on the
machine that ran #49's live drive — copied, never composed. Nothing was
rewritten, reordered or pretty-printed; the only editing is *omission* of whole
records the parser ignores anyway (`attachment`, `last-prompt`, `atis-latch`).

That is the point of the directory. Every other Claude fixture in this tree is
hand-written, and hand-written input is the exact blindness #36, #42 and #49
each found the hard way: a fixture only contains the fields whoever wrote it
already knew about. These files carry the sixteen fields a real record has —
`promptSource`, `origin`, `entrypoint`, `promptId`, `permissionMode`,
`userType`, `gitBranch`, `version` — because a real CLI wrote them.

They live in their own directory, not in `../claude-code/`, because
`src/tailing/replay.test.ts` replays that whole directory and pins its event
stream by exact equality.

## `argus-49-drive.jsonl`

Lines 1, 2, 4 and 12 of
`~/.claude/projects/-private-var-…-argus-harness-wBOI80-worktrees-live-subscription/c9cfecd3-2e6e-4a89-8b4f-11537f94cdda.jsonl`
— the transcript **#49's own subscription drive produced** (Claude Opus 5,
`claude -p`, CLI 2.1.246). Argus's own output end to end, so there is nothing
private in it.

- two `queue-operation` openers with a `sessionId` and **no `cwd`** — the shape
  that made #49 fix the `session-meta` latch;
- the dispatch prompt: `promptSource: "sdk"`, `entrypoint: "sdk-cli"`, **no
  `origin`** — the record this whole ticket is about;
- the assistant's reply.

## `task-notification.jsonl`

Lines 668 and 727 of
`~/.claude/projects/-Users-johansardar-argus-worktrees-acceptance/42659fbd-2f38-4bfe-bb06-a883bcea2492.jsonl`
— an Argus build worker's own session (CLI 2.1.245).

- a real assistant turn, which closes the session's opening run;
- a real `<task-notification>` **injected as a user-role record** with
  `promptSource: "sdk"` and `origin.kind: "task-notification"`, at line 727 of
  792: deep mid-session, hundreds of records past any preamble window.

This is the poisoning direction, and it is why #50's fix is not "add `sdk` to
the allowlist". Measured across 60 project slugs / 234 transcripts / 340,222
lines on this machine: **34 of 34** `sdk`-sourced `<task-notification>` records
arrive mid-session, so #42's envelope-plus-opening-run rule would have caught
**zero** of them and every one would have landed in USER.md as Johan.
