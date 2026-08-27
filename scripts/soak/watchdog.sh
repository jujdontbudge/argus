#!/bin/bash
# The trap that survives the driver (#105).
#
# Started detached, so it outlives the driver, the driver's terminal, and the
# agent supervising both. It tears the fleet down when ANY of three things is
# true: the driver is gone, the hard deadline has passed, or a STOP file
# appeared. The hard deadline is the one that matters — it is what makes it
# impossible for this run to still be eating Johan's machine tomorrow, even if
# every other component dies in the worst possible order.
set -uo pipefail

SCRATCH="${1:?usage: watchdog.sh <scratch-root> <driver-pid> <hard-deadline-epoch>}"
DRIVER="${2:?driver pid}"
HARD_DEADLINE="${3:?hard deadline epoch seconds}"
HERE="$(cd "$(dirname "$0")" && pwd)"

while true; do
  now=$(date +%s)
  if [ "$now" -ge "$HARD_DEADLINE" ]; then
    exec "$HERE/reap.sh" "$SCRATCH" "hard-deadline"
  fi
  if [ -f "$SCRATCH/STOP" ]; then
    exec "$HERE/reap.sh" "$SCRATCH" "stop-file"
  fi
  if ! kill -0 "$DRIVER" 2>/dev/null; then
    exec "$HERE/reap.sh" "$SCRATCH" "driver-gone"
  fi
  sleep 5
done
