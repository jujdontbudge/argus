---
name: Implementation ticket
about: A ticket that Argus can dispatch and verify automatically
title: ""
labels: ""
assignees: ""
---

## Outcome

What should be true when this ticket is complete?

## Provenance

Why is this work needed? Link the decision, issue, or source of truth.

## Scope

- In scope:
- Out of scope:

## Verification command (immutable — dispatcher-owned)

Declare exactly one safe, executable command. Argus captures it when dispatching the
ticket and runs the exact command in the ticket worktree. Do not put secrets or
untrusted interpolation in the command. Use `&&` for sequencing; do not use pipes,
redirection, command substitution, semicolons, or nested shells.

```sh
bun test path/to/relevant.test.ts
```

## Notes for the worker

Anything else the implementing agent needs to know.
