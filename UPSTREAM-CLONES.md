# Hermes clone tethers

Argus copies these Hermes policies intentionally. The listed commit is the
source revision last reviewed; `skills/hermes-upgrade/SKILL.md` requires the
paths to be diffed against every upgrade target and a drift ticket filed before
any human chooses whether to port the change.

| Argus behavior | Hermes upstream path | Cloned at |
| --- | --- | --- |
| Reviewer curator: stale after 30 days, archive after 90 | `hermes_cli/curator.py` | `9e484f05` |
| Repo-bound memory flush shape (`USER.md` / `MEMORY.md`) | `hermes_cli/memory/flush.py` | `9e484f05` |
