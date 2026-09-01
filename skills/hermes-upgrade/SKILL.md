---
name: hermes-upgrade
description: Safely validate and stage a Hermes upgrade without touching the current install.
---

# Hermes upgrade (#127)

This is machinery for an operator, not an automatic deployment. It must never
write the current Hermes venv, a live `.argus/` store, or the installed shim.

1. Fetch `NousResearch/hermes-agent` and select an explicit named tag. Record
   its commit. A dry-run against the installed version is a green no-op.
2. Create a second worktree/venv (or other side-by-side install) for the target.
   Keep the existing `~/.local/bin/hermes` shim untouched.
3. Run the scratch half of the #47 live gate with `ARGUS_LIVE_HERMES=1`, a
   scratch `HERMES_HOME`, and the new binary. Never use a live profile.
4. Capture fresh transcript, profile, and state fixtures into the scenario
   corpus additively. Never delete old fixtures: tolerant readers must parse
   sessions written by every accepted format.
5. Diff every path in `UPSTREAM-CLONES.md` between the pinned commit and target.
   Each changed path becomes a drift ticket. Porting is an explicit human/agent
   decision; it is never silently assumed.
6. If every check is green, stop and ask Johan to approve the owner-gated flip:
   switch `~/.local/bin/hermes`, update the #126 compatibility pin from the
   verified run, and commit fixtures plus the pin. Without that approval, do
   not flip or bump anything.
7. If red, file the failures as the work list and change nothing. Rollback is
   the inverse shim flip to the previous side-by-side install.

The acceptance harness supplies fake binaries and scratch directories. It never
invokes the real `hermes` CLI, network, or real installation.
