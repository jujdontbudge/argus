#!/bin/bash
# Idempotent teardown of one soak's fleet (#105).
#
# Called from THREE places on purpose: the driver's EXIT trap, the detached
# watchdog, and by hand. #89 left five watchers orphaned to launchd because
# teardown lived only in the process that got killed. Every path here is
# safe to run twice, and every kill is by a PID this run recorded or by a
# command line containing this run's UNIQUE scratch path — never by a bare
# `pgrep -f watch`, which also matches Johan's own sessions and my own shell.
set -uo pipefail

SCRATCH="${1:?usage: reap.sh <scratch-root> [reason]}"
REASON="${2:-unspecified}"
LOG="$SCRATCH/teardown.log"

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG"; }

[ -d "$SCRATCH" ] || exit 0
say "teardown start (reason: $REASON)"
touch "$SCRATCH/STOP"

kill_pid() { # <pid> <label>
  local pid="$1" label="$2"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || { say "$label pid $pid already gone"; return 0; }
  say "TERM $label pid $pid"
  kill -TERM "$pid" 2>/dev/null
}

# Order matters: stop the supervisor FIRST so it cannot restart a watcher we
# are about to kill. A watcher killed under a live supervisor is a respawn.
for name in supervisor traffic sampler; do
  kill_pid "$(cat "$SCRATCH/$name.pid" 2>/dev/null)" "$name"
done

# Watcher PIDs as the supervisor last recorded them.
if [ -f "$SCRATCH/supervisor-status.json" ]; then
  for pid in $(grep -o '"pid": *[0-9]*' "$SCRATCH/supervisor-status.json" | grep -o '[0-9]*'); do
    kill_pid "$pid" "watcher"
  done
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  remaining=$(pgrep -f -- "$SCRATCH" 2>/dev/null | grep -vx "$$" | wc -l | tr -d ' ')
  [ "$remaining" = "0" ] && break
  sleep 1
done

# Anything still alive whose command line contains this run's unique scratch
# path is unambiguously mine. Exclude this shell and the pgrep itself.
for pid in $(pgrep -f -- "$SCRATCH" 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  say "KILL leftover pid $pid: $(ps -o args= -p "$pid" 2>/dev/null | head -c 200)"
  kill -KILL "$pid" 2>/dev/null
done

say "teardown done; survivors=$(pgrep -f -- "$SCRATCH" 2>/dev/null | grep -vx "$$" | wc -l | tr -d ' ')"
