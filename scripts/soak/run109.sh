#!/bin/bash
# Drive #109's ONE 16-hour phased five-eye soak.
#
# This is #105's run.sh with the phase schedule, the in-process memory probe
# and a 16-hour budget added. `run.sh` is NOT edited: it is the driver that
# produced docs/acceptance/soak.txt and #105's series has to stay reproducible,
# for exactly the reason #110 refused to edit analyze.ts.
#
# WHAT IS REUSED UNCHANGED, on purpose, because it is the part that worked:
#   reap.sh      the three-call-site idempotent teardown (R4).
#   watchdog.sh  the detached trap that survives this driver's death.
#   seed.ts      the scratch world. #110's latency bars are only valid against
#                this exact seed vocabulary, so it must not move.
#
# ONE FLEET (R5). The ticket names three traffic arms; they are three PHASES of
# one fleet, never three fleets. Three concurrent fleets would be three times
# the blast radius of #86 (2.2-2.45 GiB per eye, ~60 GB of this machine's RAM)
# and would also confound the arms against each other through one shared load
# average — the exact confound #105 section 7 Test 2 had to control for. See
# ./phases.ts for the design.
#
# NO LAUNCHD. ARGUS_SUPERVISOR_CONTROL=disabled plus a scratch HOME means
# `supervisorConfiguration` computes manageLaunchd=false, and `argus supervisor`
# never touches launchctl anyway. The fleet is therefore killable: nothing can
# respawn it, which is exactly what went wrong in #86.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
BUN="$(command -v bun)"

# The schedule is not duplicated here. It is read out of the pre-registered
# module so the driver and the analysis cannot disagree about what ran.
DURATION_MIN="$("$BUN" "$HERE/schedule.ts" totalMinutes)"
INTERVAL_S="$("$BUN" "$HERE/schedule.ts" sampleIntervalSeconds)"
# 20 rather than #105's 10: a 16-hour run has more ways to end raggedly than a
# 3-hour one, and the grace window only ever DELAYS the hard kill, so widening
# it costs nothing and buys the sampler room to land its last samples.
GRACE_MIN=20

SCRATCH="$(mktemp -d /private/tmp/argus-soak-XXXXXX)"
echo "$SCRATCH" >"$SRC/.soak-scratch"
HOME_DIR="$SCRATCH/home"
REPO="$SCRATCH/repo"
mkdir -p "$HOME_DIR" "$REPO"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$SCRATCH/driver.log"; }

trap '"$HERE/reap.sh" "$SCRATCH" "driver-trap"' EXIT INT TERM

log "scratch=$SCRATCH duration=${DURATION_MIN}m interval=${INTERVAL_S}s (phased, #109)"

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

# The 512 MiB per-eye ceiling. Already the in-process default
# (src/watch.ts DEFAULT_WATCH_MAX_RSS_MIB), and a watcher that breaches it
# SELF-TERMINATES from inside its own loop for a supervised restart — it is not
# merely recorded. Set explicitly anyway so the run states its own ceiling
# instead of inheriting it silently.
export ARGUS_WATCH_MAX_RSS_MB=512

# The in-process probe (#105 section 7 item 4). Off everywhere else: the only
# thing that turns it on is this variable being set.
export ARGUS_WATCH_MEMPROBE_FILE="$SCRATCH/memprobe.jsonl"
export ARGUS_WATCH_MEMPROBE_MS=$(( INTERVAL_S * 1000 ))

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
# ONE clock for the whole run. The sampler labels samples with a phase and the
# traffic generator changes rate on a phase boundary; handing both the SAME
# origin is what makes "minute 210" mean the same instant to both. Without it
# they would drift by however long this driver takes between spawning them.
RUN_START_MS=$(( NOW * 1000 ))
SOFT_DEADLINE=$(( NOW + DURATION_MIN * 60 ))
HARD_DEADLINE=$(( SOFT_DEADLINE + GRACE_MIN * 60 ))
DEADLINE_MS=$(( SOFT_DEADLINE * 1000 ))

"$BUN" "$HERE/schedule.ts" json "$NOW" >"$SCRATCH/schedule.json"

cat >"$SCRATCH/run.json" <<JSON
{
  "ticket": 109,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "runStartEpochMs": $RUN_START_MS,
  "plannedMinutes": $DURATION_MIN,
  "sampleIntervalSeconds": $INTERVAL_S,
  "phased": true,
  "schedule": "schedule.json",
  "memProbe": "memprobe.jsonl",
  "softDeadlineEpoch": $SOFT_DEADLINE,
  "hardDeadlineEpoch": $HARD_DEADLINE,
  "plannedEndUtc": "$(date -r "$SOFT_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)",
  "hardEndUtc": "$(date -r "$HARD_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)",
  "scratch": "$SCRATCH",
  "repo": "$REAL_REPO",
  "watchMaxRssMiB": 512,
  "pollMs": 250,
  "baselineArm": "/private/tmp/argus-soak-czkoLx"
}
JSON

# ---- the fleet -----------------------------------------------------------
"$BUN" "$SRC/src/cli.ts" supervisor >>"$SCRATCH/supervisor.out" 2>>"$SCRATCH/supervisor.log" &
SUPERVISOR_PID=$!
echo "$SUPERVISOR_PID" >"$SCRATCH/supervisor.pid"
log "supervisor pid $SUPERVISOR_PID"

"$BUN" "$HERE/traffic.ts" "$CODEX_DIR" "$DEADLINE_MS" "$SUPERVISOR_PID" --phased "$RUN_START_MS" \
  >>"$SCRATCH/traffic.log" 2>&1 &
echo $! >"$SCRATCH/traffic.pid"

"$BUN" "$HERE/sampler.ts" "$SCRATCH" "$(( INTERVAL_S * 1000 ))" "$DEADLINE_MS" "$SUPERVISOR_PID" "$RUN_START_MS" \
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
# incident signature and far above anything a healthy fleet does.
#
# THE GUARD IS RE-DISARMED AT EVERY PHASE BOUNDARY, which #105 did not need.
# Stepping the traffic rate 10x is a real, intended, transient change in the
# fleet's working set, and a guard that cannot tell that from #86 would abort
# this run on its own design. Re-arming after PHASE_SETTLE minutes uses the
# same settling allowance the analysis discards, so the guard is blind to
# exactly the samples the verdict is blind to and to no others. Between
# boundaries it is fully armed, which is where a real runaway would show.
ABORT_GAIN_MIB=250
GUARD_ARM_MIN=10
PHASE_SETTLE_MIN="$("$BUN" "$HERE/schedule.ts" phaseSettleMinutes)"
GUARD_WINDOW=$(( 300 / INTERVAL_S ))
[ "$GUARD_WINDOW" -lt 2 ] && GUARD_WINDOW=2
GUARD_ARMED_AT=$(( NOW + GUARD_ARM_MIN * 60 ))
LAST_PHASE=""

while [ "$(date +%s)" -lt "$SOFT_DEADLINE" ]; do
  sleep 15
  [ -f "$SCRATCH/STOP" ] && { log "STOP file present; ending"; break; }
  kill -0 "$SUPERVISOR_PID" 2>/dev/null || { log "supervisor died; ending"; break; }

  phase=$(tail -n 1 "$SCRATCH/series.jsonl" 2>/dev/null \
    | grep -o '"label":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$phase" ] && [ "$phase" != "$LAST_PHASE" ]; then
    [ -n "$LAST_PHASE" ] && GUARD_ARMED_AT=$(( $(date +%s) + PHASE_SETTLE_MIN * 60 ))
    LAST_PHASE="$phase"
    log "phase -> $phase (guard re-arms $(date -r "$GUARD_ARMED_AT" -u +%H:%M:%SZ))"
  fi

  [ "$(date +%s)" -lt "$GUARD_ARMED_AT" ] && continue
  window=$(tail -n "$GUARD_WINDOW" "$SCRATCH/series.jsonl" 2>/dev/null \
    | grep -o '"totalRssMiB":[0-9.]*' | grep -o '[0-9.]*')
  [ -z "$window" ] && continue
  first=$(echo "$window" | head -1); last=$(echo "$window" | tail -1)
  gain=$(echo "$last $first" | awk '{printf "%d", $1-$2}')
  if [ "$gain" -ge "$ABORT_GAIN_MIB" ]; then
    log "ABORT: fleet RSS gained ${gain} MiB over the guard window (${first} -> ${last} MiB)"
    echo "runaway-rss gain=${gain}MiB from=${first} to=${last} phase=${LAST_PHASE}" >"$SCRATCH/ABORTED"
    break
  fi
done

log "soak loop finished"
