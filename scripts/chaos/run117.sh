#!/bin/bash
# Drive #117's ONE chaos fleet: 2 sandbox repos, one supervisor, 10 watchers,
# real SIGKILLs against real watcher processes.
#
# REUSED UNCHANGED, because the ticket says to reuse scripts/soak/reap.sh's
# pattern rather than re-derive it, and because these are the parts that worked
# across #105, #109 and #116:
#   scripts/soak/reap.sh      three-call-site idempotent teardown (R4). Kills by
#                             recorded pid AND by this run's unique scratch path.
#   scripts/soak/watchdog.sh  the detached trap that survives this driver's death.
#   scripts/scale/seed116.ts  the scratch world. #117 needs exactly what #116
#                             built — N git repos under one scratch HOME with
#                             per-repo `marker<i>` tokens — so it is called, not
#                             copied. No file above is edited; #105's, #109's and
#                             #116's evidence has to stay reproducible.
#
# ONE FLEET (R5). Two repos is 2 x 5 watchers under ONE supervisor.
#
# NO LAUNCHD, exactly as run109.sh and run116.sh arrange it:
# ARGUS_SUPERVISOR_CONTROL=disabled plus a scratch HOME makes
# `supervisorConfiguration` compute manageLaunchd=false, and
# ARGUS_LAUNCHCTL=/usr/bin/false means even a bug could not reach launchctl. The
# fleet is therefore killable — which for THIS ticket is not merely convenient,
# it is a safety precondition: the killer refuses to fire at all if
# `launchctl list` reports any argus entry, because a launchd-owned watcher is
# not unambiguously ours to kill.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SOAK="$HERE/../soak"
SCALE="$HERE/../scale"
SRC="$(cd "$HERE/.." && cd .. && pwd)"
BUN="$(command -v bun)"

REPO_COUNT="${ARGUS_CHAOS_REPOS:-2}"
DURATION_MIN="${ARGUS_CHAOS_MINUTES:-70}"
INTERVAL_S="${ARGUS_CHAOS_INTERVAL_S:-15}"
GRACE_MIN=20

# R5 PREFLIGHT, re-checked here rather than trusted from the dispatch note: a
# second live fleet would make every pid in this run ambiguous, and this is the
# one ticket that kills pids.
LIVE_WATCHERS=$(ps -eo args | grep 'cli.ts watch' | grep -v grep | wc -l | tr -d ' ')
LAUNCHD_ARGUS=$(launchctl list | grep -ci argus | tr -d ' ')
if [ "$LIVE_WATCHERS" != "0" ] || [ "$LAUNCHD_ARGUS" != "0" ]; then
  echo "REFUSING TO START: live watchers=$LIVE_WATCHERS launchd argus=$LAUNCHD_ARGUS (both must be 0)" >&2
  exit 2
fi

SCRATCH="$(mktemp -d /private/tmp/argus-chaos-XXXXXX)"
echo "$SCRATCH" >"$SRC/.chaos-scratch"
HOME_DIR="$SCRATCH/home"
mkdir -p "$HOME_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$SCRATCH/driver.log"; }

trap '"$SOAK/reap.sh" "$SCRATCH" "driver-trap"' EXIT INT TERM

log "scratch=$SCRATCH repos=$REPO_COUNT duration=${DURATION_MIN}m interval=${INTERVAL_S}s"
log "preflight live watchers=$LIVE_WATCHERS launchd argus=$LAUNCHD_ARGUS"

# ---- scratch world (seed116.ts, unchanged) -------------------------------
"$BUN" "$SCALE/seed116.ts" "$SCRATCH" "$REPO_COUNT" | tee -a "$SCRATCH/driver.log"

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
export ARGUS_WATCH_MAX_RSS_MB=512

: >"$ARGUS_REPOS_FILE"
for index in $(seq 0 $(( REPO_COUNT - 1 ))); do
  REPO="$SCRATCH/repo-$index"
  mkdir -p "$REPO"
  git init --quiet "$REPO"
  ( cd "$REPO" \
    && git config user.email chaos@invalid.example \
    && git config user.name "Argus Chaos" \
    && echo "chaos $index" >README.md && git add README.md \
    && git -c commit.gpgsign=false commit --quiet -m "chaos fixture $index" )
  ( cd "$REPO" && "$BUN" "$SRC/src/cli.ts" init ) >>"$SCRATCH/init-$index.log" 2>&1
  mkdir -p "$REPO/.argus"
  printf 'url: http://localhost:8000\nworkspace: argus-chaos-117-%s\n' "$index" \
    >"$REPO/.argus/honcho.yaml"
  REAL="$(cd "$REPO" && pwd -P)"
  printf '%s\n' "$REAL" >>"$ARGUS_REPOS_FILE"
  log "enrolled $REAL"
done

# ---- deadlines -----------------------------------------------------------
NOW=$(date +%s)
RUN_START_MS=$(( NOW * 1000 ))
SOFT_DEADLINE=$(( NOW + DURATION_MIN * 60 ))
HARD_DEADLINE=$(( SOFT_DEADLINE + GRACE_MIN * 60 ))
DEADLINE_MS=$(( SOFT_DEADLINE * 1000 ))

cat >"$SCRATCH/run.json" <<JSON
{
  "ticket": 117,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "runStartEpochMs": $RUN_START_MS,
  "plannedMinutes": $DURATION_MIN,
  "sampleIntervalSeconds": $INTERVAL_S,
  "repoCount": $REPO_COUNT,
  "topology": "one HOME, one supervisor, $REPO_COUNT repos, 5x$REPO_COUNT watchers",
  "targetRepoIndex": 0,
  "bystanderRepoIndex": 1,
  "rowsPerSecondPerRepo": 1,
  "phasesMinutes": { "warmup": 10, "chaos": 45, "brake": 55, "settle": $DURATION_MIN },
  "softDeadlineEpoch": $SOFT_DEADLINE,
  "hardDeadlineEpoch": $HARD_DEADLINE,
  "plannedEndUtc": "$(date -r "$SOFT_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)",
  "hardEndUtc": "$(date -r "$HARD_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)",
  "scratch": "$SCRATCH",
  "home": "$HOME_DIR",
  "watchMaxRssMiB": 512,
  "analysis": "scripts/chaos/analyze117.ts (pre-registered)"
}
JSON

# `pmset -g log` BEFORE the run, so the after-capture can be diffed against it
# rather than mined for entries that were already there (ticket item 3).
pmset -g log 2>/dev/null | grep -iE 'Sleep|Wake|DarkWake' | tail -n 50 >"$SCRATCH/pmset-before.txt"

# ---- the fleet -----------------------------------------------------------
"$BUN" "$SRC/src/cli.ts" supervisor >>"$SCRATCH/supervisor.out" 2>>"$SCRATCH/supervisor.log" &
SUPERVISOR_PID=$!
echo "$SUPERVISOR_PID" >"$SCRATCH/supervisor.pid"
log "supervisor pid $SUPERVISOR_PID"

"$BUN" "$HERE/traffic117.ts" "$SCRATCH" "$DEADLINE_MS" "$SUPERVISOR_PID" "$REPO_COUNT" \
  >>"$SCRATCH/traffic.log" 2>&1 &
echo $! >"$SCRATCH/traffic.pid"

"$BUN" "$HERE/sampler117.ts" "$SCRATCH" "$(( INTERVAL_S * 1000 ))" "$DEADLINE_MS" \
  "$SUPERVISOR_PID" "$RUN_START_MS" "$REPO_COUNT" >>"$SCRATCH/sampler.log" 2>&1 &
echo $! >"$SCRATCH/sampler.pid"

"$BUN" "$HERE/killer117.ts" "$SCRATCH" "$DEADLINE_MS" "$SUPERVISOR_PID" "$RUN_START_MS" \
  >>"$SCRATCH/killer.log" 2>&1 &
echo $! >"$SCRATCH/killer.pid"
log "killer pid $(cat "$SCRATCH/killer.pid")"

# ---- the trap that survives this driver ----------------------------------
nohup "$SOAK/watchdog.sh" "$SCRATCH" "$$" "$HARD_DEADLINE" >>"$SCRATCH/watchdog.log" 2>&1 &
echo $! >"$SCRATCH/watchdog.pid"
log "watchdog pid $(cat "$SCRATCH/watchdog.pid") hard deadline $(date -r "$HARD_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)"

# reap.sh already TERMs supervisor/traffic/sampler by name; the killer is this
# run's fourth long-lived helper and it is not in that list. Rather than edit a
# file three published evidence runs depend on, the driver records the killer's
# pid in reap.sh's own `<name>.pid` convention AND the killer exits on its own
# when the supervisor pid it was handed dies — which reap.sh kills first.
# Belt and braces, and neither one touches reap.sh.

# ---- supervise -----------------------------------------------------------
# The same two guards run116.sh registered, with the same numbers, checked
# against the same sampled field. Aborting IS a result: a fleet that cannot be
# held is the finding, to be reported rather than pushed through.
ABORT_GAIN_MIB=250
RAM_GUARD_MIB=3072
GUARD_ARM_MIN=10
GUARD_WINDOW=$(( 300 / INTERVAL_S ))
[ "$GUARD_WINDOW" -lt 2 ] && GUARD_WINDOW=2
GUARD_ARMED_AT=$(( NOW + GUARD_ARM_MIN * 60 ))

while [ "$(date +%s)" -lt "$SOFT_DEADLINE" ]; do
  sleep 15
  [ -f "$SCRATCH/STOP" ] && { log "STOP file present; ending"; break; }
  kill -0 "$SUPERVISOR_PID" 2>/dev/null || { log "supervisor died; ending"; break; }
  # A dead killer means a run with no chaos in it. analyze117.ts already cannot
  # score that as a pass (its budget check requires at least one judged kill),
  # but it must be visible in the driver log at the time, not only afterwards.
  kill -0 "$(cat "$SCRATCH/killer.pid")" 2>/dev/null || {
    [ -f "$SCRATCH/KILLER-GONE" ] || { log "WARNING: killer process is gone"; touch "$SCRATCH/KILLER-GONE"; }
  }

  machine=$(tail -n 1 "$SCRATCH/series.jsonl" 2>/dev/null \
    | grep -o '"machineBunRssMiB":[0-9.]*' | grep -o '[0-9.]*')
  if [ -n "$machine" ]; then
    machine_mib=$(echo "$machine" | awk '{printf "%d", $1}')
    if [ "$machine_mib" -ge "$RAM_GUARD_MIB" ]; then
      log "ABORT: whole-machine bun RSS ${machine_mib} MiB >= guard ${RAM_GUARD_MIB} MiB"
      echo "ram-guard machineBunRssMiB=${machine_mib} guard=${RAM_GUARD_MIB}" >"$SCRATCH/ABORTED"
      break
    fi
  fi

  [ "$(date +%s)" -lt "$GUARD_ARMED_AT" ] && continue
  window=$(tail -n "$GUARD_WINDOW" "$SCRATCH/series.jsonl" 2>/dev/null \
    | grep -o '"fleetRssMiB":[0-9.]*' | grep -o '[0-9.]*')
  [ -z "$window" ] && continue
  first=$(echo "$window" | head -1); last=$(echo "$window" | tail -1)
  gain=$(echo "$last $first" | awk '{printf "%d", $1-$2}')
  if [ "$gain" -ge "$ABORT_GAIN_MIB" ]; then
    log "ABORT: fleet RSS gained ${gain} MiB over the guard window (${first} -> ${last} MiB)"
    echo "runaway-rss gain=${gain}MiB from=${first} to=${last}" >"$SCRATCH/ABORTED"
    break
  fi
done

pmset -g log 2>/dev/null | grep -iE 'Sleep|Wake|DarkWake' | tail -n 200 >"$SCRATCH/pmset-after.txt"
log "chaos run loop finished"
