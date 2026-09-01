# Argus

Orchestration and self-learning toolkit for multi-agent software building: watchers
that turn everything that happens in a repo's sessions into durable structure.

## Language

**Converge**:
What `argus up` does — bring a repo to the fully-set-up state from any starting
point, idempotently; first run and hundredth run are the same command.
_Avoid_: install (that's the one-time PATH bootstrap), setup script

**Enrollment**:
Registering a repo with the supervisor and loading its watcher jobs — the setup
command's half of startup, as opposed to supervision.
_Avoid_: activation, onboarding

**Supervision**:
Keeping enrolled watchers alive across logins and crashes — launchd's half of
startup, as opposed to enrollment.

**Tracker-less mode**:
The degraded state of a repo with no GitHub remote: watchers run normally but
ticket/retro filing falls back to digest-only.
_Avoid_: offline mode, local mode

**Eye**:
One of the five independent watcher processes of a repo instance (Reviewer,
Archiver, Honcho, Digest, Retro).
_Avoid_: daemon, service

**Brain**:
The per-invocation LLM judgment call backing an evaluative eye (Reviewer, Digest) —
the thing that fires and returns a verdict, as opposed to the always-running eye
process it serves.
_Avoid_: model (that's a knob of the brain), watcher (that's the eye)

**Coalesce buffer**:
An eye's accumulation of turns its brain has not yet seen; it empties only into a
brain invocation and never drops — the mechanism behind "no turn skipped."
_Avoid_: queue (implies items are processed one at a time)
