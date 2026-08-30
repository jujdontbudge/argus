# Per-repository completion gates

`argus complete` verifies a ticket with the managed repository's own commands. A
gate is an ordered, named command that runs in the ticket worktree. Commands are
argv lists, not shell strings: Argus does not add quoting, expansion, pipes, or
redirection. The first non-zero exit stops verification and leaves the ticket
open, claimed, and queued.

## Resolution contract

Argus resolves gates independently for each managed repository, in this order:

1. If `.argus/config.yaml` contains `completion.gates`, that exact non-empty list
   is authoritative.
2. Otherwise, Argus detects the Bun/TypeScript contract only when the ticket
   worktree root contains all of the following: `package.json` with non-empty
   `scripts.typecheck` and `scripts.test`, `tsconfig.json`, and `bun.lock` or
   `bun.lockb`. The gates are `bun run typecheck` followed by `bun run test`.
3. Otherwise, completion fails closed with a configuration error explaining how
   to add `completion.gates`. No command is run and the queued ticket remains
   queued.

This deliberately does not infer Python, documentation, or nested JavaScript
commands from filenames or directory names. Those are not authoritative build
manifests, and guessing could either skip required checks or run unrelated tools.
In particular, the absence of a root TypeScript project never selects `tsc`.

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

`completion.gates` must be a non-empty YAML list. Every entry must have a
non-empty string `name` and a non-empty `command` list containing only non-empty
strings. Invalid YAML, invalid entries, and an explicit empty list are
configuration errors, never an empty successful verification.

Because `.argus/` is operational state and is gitignored, configure this once in
each managed checkout. Re-run `argus complete` after correcting an error; the
durable verification queue will retry the same ticket.
