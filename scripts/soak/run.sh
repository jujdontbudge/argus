#!/bin/bash
# Drive one warmed five-eye soak (#105).
#
# Backgrounded and polled, never foregrounded: the Bash ceiling is 10 minutes
# and this run is hours. Nothing here needs the driver to stay alive in order
# to leave evidence — the sampler writes to disk continuously and the watchdog
# tears the fleet down whether the driver lives or not.
#
# NO LAUNCHD. ARGUS_SUPERVISOR_CONTROL=disabled plus a scratch HOME means
# `supervisorConfiguration` computes manageLaunchd=false, and `argus supervisor`
# never touches launchctl anyway. The fleet is therefore killable: nothing can
# respawn it, which is exactly what went wrong in #86.
set -uo pipefail

DURATION_MIN="${1:?usage: run.sh <duration-minutes> <sample-interval-seconds>}"
INTERVAL_S="${2:-30}"
GRACE_MIN=10

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
BUN="$(command -v bun)"

SCRATCH="$(mktemp -d /private/tmp/argus-soak-XXXXXX)"
echo "$SCRATCH" >"$SRC/.soak-scratch"
HOME_DIR="$SCRATCH/home"
REPO="$SCRATCH/repo"
mkdir -p "$HOME_DIR" "$REPO"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$SCRATCH/driver.log"; }

trap '"$HERE/reap.sh" "$SCRATCH" "driver-trap"' EXIT INT TERM

log "scratch=$SCRATCH duration=${DURATION_MIN}m interval=${INTERVAL_S}s"

# ---- scratch world -------------------------------------------------------
"$BUN" "$HERE/seed.ts" "$SCRATCH" | tee -a "$SCRATCH/driver.log"

git init --quiet "$REPO"
( cd "$REPO" \
  && git config user.email soak@invalid.example \
  && git config user.name "Argus Soak" \
  && echo "soak" >README.md && git add README.md \
  && git -c commit.gpgsign=false commit --quiet -m "soak fixture" )

CODEX_DIR="$HOME_DIR/.codex/sessions/2026/08/26"

export HOME="$HOME_DIR"
export CODEX_HOME="$HOME_DIR/.codex"
export CLAUDE_CONFIG_DIR="$HOME_DIR/.claude"
export HERMES_HOME="$HOME_DIR/.hermes"
export ARGUS_REPOS_FILE="$SCRATCH/argus-repos"
export ARGUS_SUPERVISOR_STATUS_FILE="$SCRATCH/supervisor-status.json"
export ARGUS_SUPERVISOR_PLIST="$SCRATCH/never-installed.plist"
export ARGUS_SUPERVISOR_LOG_FILE="$SCRATCH/supervisor-job.log"
export ARGUS_SUPERVISOR_CONTROL=disabled
export ARGUS_LAUNCHCTL=/usr/bin/false

# `argus init` is repo-local by contract: no network, no launchd, no processes.
( cd "$REPO" && "$BUN" "$SRC/src/cli.ts" init ) >>"$SCRATCH/init.log" 2>&1
if [ ! -f "$REPO/.argus/honcho.yaml" ]; then
  mkdir -p "$REPO/.argus"
  printf 'url: http://localhost:8000\nworkspace: argus-soak\n' >"$REPO/.argus/honcho.yaml"
  log "wrote fallback honcho.yaml"
fi

REAL_REPO="$(cd "$REPO" && pwd -P)"
printf '%s\n' "$REAL_REPO" >"$ARGUS_REPOS_FILE"
log "enrolled $REAL_REPO"

# ---- deadlines -----------------------------------------------------------
NOW=$(date +%s)
SOFT_DEADLINE=$(( NOW + DURATION_MIN * 60 ))
HARD_DEADLINE=$(( SOFT_DEADLINE + GRACE_MIN * 60 ))
DEADLINE_MS=$(( SOFT_DEADLINE * 1000 ))
cat >"$SCRATCH/run.json" <<JSON
{
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "plannedMinutes": $DURATION_MIN,
  "sampleIntervalSeconds": $INTERVAL_S,
  "warmupMinutes": 30,
  "softDeadlineEpoch": $SOFT_DEADLINE,
  "hardDeadlineEpoch": $HARD_DEADLINE,
  "scratch": "$SCRATCH",
  "repo": "$REAL_REPO",
  "watchMaxRssMiB": 512,
  "pollMs": 250
}
JSON

# ---- the fleet -----------------------------------------------------------
"$BUN" "$SRC/src/cli.ts" supervisor >>"$SCRATCH/supervisor.out" 2>>"$SCRATCH/supervisor.log" &
SUPERVISOR_PID=$!
echo "$SUPERVISOR_PID" >"$SCRATCH/supervisor.pid"
log "supervisor pid $SUPERVISOR_PID"

"$BUN" "$HERE/traffic.ts" "$CODEX_DIR" "$DEADLINE_MS" "$SUPERVISOR_PID" \
  >>"$SCRATCH/traffic.log" 2>&1 &
echo $! >"$SCRATCH/traffic.pid"

"$BUN" "$HERE/sampler.ts" "$SCRATCH" "$(( INTERVAL_S * 1000 ))" "$DEADLINE_MS" "$SUPERVISOR_PID" \
  >>"$SCRATCH/sampler.log" 2>&1 &
echo $! >"$SCRATCH/sampler.pid"

# ---- the trap that survives this driver ----------------------------------
nohup "$HERE/watchdog.sh" "$SCRATCH" "$$" "$HARD_DEADLINE" >>"$SCRATCH/watchdog.log" 2>&1 &
echo $! >"$SCRATCH/watchdog.pid"
log "watchdog pid $(cat "$SCRATCH/watchdog.pid") hard deadline $(date -r "$HARD_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- supervise -----------------------------------------------------------
# Directive 14: if the fleet starts climbing like #86, stop the soak. #86 grew
# ~200 MiB/min PER EYE (~1000 MiB/min for five). The guard trips at 250 MiB
# gained over five minutes (50 MiB/min fleet-wide) — twenty times below the
# incident signature and far above anything a healthy fleet does, so it aborts
# on a real leak long before it costs Johan anything.
ABORT_GAIN_MIB=250
GUARD_WINDOW=$(( 300 / INTERVAL_S ))
[ "$GUARD_WINDOW" -lt 2 ] && GUARD_WINDOW=2

while [ "$(date +%s)" -lt "$SOFT_DEADLINE" ]; do
  sleep 15
  [ -f "$SCRATCH/STOP" ] && { log "STOP file present; ending"; break; }
  kill -0 "$SUPERVISOR_PID" 2>/dev/null || { log "supervisor died; ending"; break; }
  window=$(tail -n "$GUARD_WINDOW" "$SCRATCH/series.jsonl" 2>/dev/null \
    | grep -o '"totalRssMiB":[0-9.]*' | grep -o '[0-9.]*')
  [ -z "$window" ] && continue
  first=$(echo "$window" | head -1); last=$(echo "$window" | tail -1)
  gain=$(echo "$last $first" | awk '{printf "%d", $1-$2}')
  if [ "$gain" -ge "$ABORT_GAIN_MIB" ]; then
    log "ABORT: fleet RSS gained ${gain} MiB over the guard window (${first} -> ${last} MiB)"
    echo "runaway-rss gain=${gain}MiB from=${first} to=${last}" >"$SCRATCH/ABORTED"
    break
  fi
done

log "soak loop finished"
