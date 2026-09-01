# Per-repository completion gates

`argus complete` first runs the ticket's own immutable verification command in the
ticket worktree. A ticket must contain exactly one `## Verification` or
`## Verification command (immutable...)` section with exactly one `sh`-family fenced
command. The dispatcher captures that command and the SHA-256 of the complete ticket
body in `.argus/dispatch/verification/ticket-<number>.json`; the record is write-once.
The command therefore cannot be replaced by an agent or by a later tracker edit.

Declared commands use a conservative shell subset: words joined by `&&`. Shell
expansion, pipelines, redirection, control characters, and nested shell evaluation
are rejected. The exact command text is executed with `sh -c` and the ticket
worktree as its working directory. A missing, ambiguous, malformed, unsafe, or
changed declaration fails closed and leaves the ticket open and queued.

Repository policy gates are an explicit additional layer. They are argv lists, not
shell strings: Argus does not add quoting, expansion, pipes, or redirection. When
configured, they run after the declared command; a repository's unrelated inferred
Bun/TypeScript defaults are not substituted for the ticket command. The first
non-zero exit stops verification and leaves the ticket open, claimed, and queued.

## Resolution contract

Argus resolves verification independently for each managed repository, in this order:

1. The dispatch-captured ticket command is mandatory and runs first.
2. If `.argus/config.yaml` contains `completion.gates`, that exact non-empty list
   runs as additional repository policy.
3. If no additional repository gates are configured, the declared command and a
   clean review are sufficient. Completion does not infer a fixed gate set that
   could be unrelated to the ticket.

The standalone `resolveRepositoryGates` API still detects the historical
Bun/TypeScript root-manifest contract for repository policy callers, but
`argus complete` does not use that inference to replace or impose checks on a
ticket's declaration.

This deliberately does not infer Python, documentation, or nested JavaScript
commands from filenames or directory names. Those are not authoritative build
manifests, and guessing could either skip required checks or run unrelated tools.

## Explicit configuration

Repositories without the detected Bun/TypeScript shape configure their native
commands in the machine-local, repository-scoped `.argus/config.yaml`:

```yaml
completion:
  gates:
    - name: tests
      command: [python3, -m, unittest, discover, -s, tests]
    - name: validator
      command: [python3, scripts/validate_content.py]
    - name: json
      command: [python3, -m, json.tool, governance/content.json]
    - name: whitespace
      command: [git, diff, --check, main...HEAD]
```

`completion.gates` must be a non-empty YAML list when repository policy is enabled.
Every entry must have a
non-empty string `name` and a non-empty `command` list containing only non-empty
strings. Invalid YAML, invalid entries, and an explicit empty list are
configuration errors, never an empty successful verification.

Because `.argus/` is operational state and is gitignored, configure this once in
each managed checkout. Re-run `argus complete` after correcting an error; the
durable verification queue will retry the same ticket. Correcting the ticket's
verification section requires a new dispatch so Argus can capture a new immutable
record.
