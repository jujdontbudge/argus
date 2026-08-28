#!/bin/bash
# Drive #116's ONE multi-repo fleet: N sandbox repos, one supervisor, 5xN watchers.
#
# WHAT IS REUSED UNCHANGED, because #116 says to reuse the #105/#109 scaffolding
# rather than re-derive it, and because it is the part that worked:
#   scripts/soak/reap.sh      the three-call-site idempotent teardown (R4). It
#                             already kills by recorded pid AND by this run's
#                             unique scratch path, and every repo-N lives under
#                             that path, so it needs no multi-repo change at all.
#   scripts/soak/watchdog.sh  the detached trap that survives this driver's death.
# Neither file is edited. #105's and #109's evidence has to stay reproducible.
#
# ONE FLEET (R5). N repos is N x 5 watchers under ONE supervisor, which is the
# topology #116 asks about; it is not N fleets. Nothing else may have a fleet up
# while this runs.
#
# NO LAUNCHD, exactly as run109.sh arranges it: ARGUS_SUPERVISOR_CONTROL=disabled
# plus a scratch HOME makes `supervisorConfiguration` compute manageLaunchd=false,
# and ARGUS_LAUNCHCTL=/usr/bin/false means even a bug could not reach launchctl.
# The fleet is therefore killable, which is what #86 was not.
#
# ONE HOME FOR ALL N REPOS. This is deliberate and is argued in full in
# scripts/scale/seed116.ts: one supervisor resolves exactly one HOME
# (src/supervisor/control.ts:137-196, src/supervisor/daemon.ts:9-33), so N HOMEs
# would need N supervisors. It is also the harder case and the production one.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SOAK="$HERE/../soak"
SRC="$(cd "$HERE/../.." && pwd)"
BUN="$(command -v bun)"

REPO_COUNT="${ARGUS_SCALE_REPOS:-3}"
DURATION_MIN="${ARGUS_SCALE_MINUTES:-150}"
INTERVAL_S=30
# #109 widened this from 10 to 20 because a long run has more ways to end
# raggedly, and the grace window only ever DELAYS the hard kill.
GRACE_MIN=20

SCRATCH="$(mktemp -d /private/tmp/argus-scale-XXXXXX)"
echo "$SCRATCH" >"$SRC/.scale-scratch"
HOME_DIR="$SCRATCH/home"
mkdir -p "$HOME_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$SCRATCH/driver.log"; }

trap '"$SOAK/reap.sh" "$SCRATCH" "driver-trap"' EXIT INT TERM

log "scratch=$SCRATCH repos=$REPO_COUNT duration=${DURATION_MIN}m interval=${INTERVAL_S}s"

# ---- scratch world -------------------------------------------------------
"$BUN" "$HERE/seed116.ts" "$SCRATCH" "$REPO_COUNT" | tee -a "$SCRATCH/driver.log"

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
# The 512 MiB PER-EYE ceiling (src/watch.ts DEFAULT_WATCH_MAX_RSS_MIB). Stated
# rather than inherited so the run declares its own ceiling.
export ARGUS_WATCH_MAX_RSS_MB=512

: >"$ARGUS_REPOS_FILE"
for index in $(seq 0 $(( REPO_COUNT - 1 ))); do
  REPO="$SCRATCH/repo-$index"
  mkdir -p "$REPO"
  # Each sandbox is its OWN git repository. `repositoryFor` walks up to the
  # nearest `.git`, so siblings sharing one would collapse onto one identity and
  # the isolation question would be unaskable.
  git init --quiet "$REPO"
  ( cd "$REPO" \
    && git config user.email scale@invalid.example \
    && git config user.name "Argus Scale" \
    && echo "scale $index" >README.md && git add README.md \
    && git -c commit.gpgsign=false commit --quiet -m "scale fixture $index" )
  ( cd "$REPO" && "$BUN" "$SRC/src/cli.ts" init ) >>"$SCRATCH/init-$index.log" 2>&1
  # A DISTINCT Honcho workspace per repo. The Hermes branch of `combine()` is
  # the one source NOT wrapped in `sessionsForRepo` — it is scoped by workspace
  # instead — so two repos sharing a workspace would share a Hermes stream.
  mkdir -p "$REPO/.argus"
  printf 'url: http://localhost:8000\nworkspace: argus-scale-116-%s\n' "$index" \
    >"$REPO/.argus/honcho.yaml"
  REAL="$(cd "$REPO" && pwd -P)"
  printf '%s\n' "$REAL" >>"$ARGUS_REPOS_FILE"
  log "enrolled $REAL"
done

# ---- deadlines -----------------------------------------------------------
NOW=$(date +%s)
# ONE clock, shared by the sampler and the traffic generator, so "minute 40"
# means the same instant to the thing writing rows and the thing counting them.
RUN_START_MS=$(( NOW * 1000 ))
SOFT_DEADLINE=$(( NOW + DURATION_MIN * 60 ))
HARD_DEADLINE=$(( SOFT_DEADLINE + GRACE_MIN * 60 ))
DEADLINE_MS=$(( SOFT_DEADLINE * 1000 ))

cat >"$SCRATCH/run.json" <<JSON
{
  "ticket": 116,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "runStartEpochMs": $RUN_START_MS,
  "plannedMinutes": $DURATION_MIN,
  "sampleIntervalSeconds": $INTERVAL_S,
  "repoCount": $REPO_COUNT,
  "topology": "one HOME, one supervisor, $REPO_COUNT repos, 5x$REPO_COUNT watchers",
  "ratesRowsPerSample": { "repo-0": 30, "repo-1": 300, "repo-2+": 0 },
  "softDeadlineEpoch": $SOFT_DEADLINE,
  "hardDeadlineEpoch": $HARD_DEADLINE,
  "plannedEndUtc": "$(date -r "$SOFT_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)",
  "hardEndUtc": "$(date -r "$HARD_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)",
  "scratch": "$SCRATCH",
  "home": "$HOME_DIR",
  "watchMaxRssMiB": 512,
  "analysis": "scripts/scale/analyze116.ts (pre-registered)"
}
JSON

# ---- the fleet -----------------------------------------------------------
"$BUN" "$SRC/src/cli.ts" supervisor >>"$SCRATCH/supervisor.out" 2>>"$SCRATCH/supervisor.log" &
SUPERVISOR_PID=$!
echo "$SUPERVISOR_PID" >"$SCRATCH/supervisor.pid"
log "supervisor pid $SUPERVISOR_PID"

"$BUN" "$HERE/traffic116.ts" "$SCRATCH" "$DEADLINE_MS" "$SUPERVISOR_PID" "$REPO_COUNT" \
  >>"$SCRATCH/traffic.log" 2>&1 &
echo $! >"$SCRATCH/traffic.pid"

"$BUN" "$HERE/sampler116.ts" "$SCRATCH" "$(( INTERVAL_S * 1000 ))" "$DEADLINE_MS" \
  "$SUPERVISOR_PID" "$RUN_START_MS" "$REPO_COUNT" >>"$SCRATCH/sampler.log" 2>&1 &
echo $! >"$SCRATCH/sampler.pid"

# ---- the trap that survives this driver ----------------------------------
nohup "$SOAK/watchdog.sh" "$SCRATCH" "$$" "$HARD_DEADLINE" >>"$SCRATCH/watchdog.log" 2>&1 &
echo $! >"$SCRATCH/watchdog.pid"
log "watchdog pid $(cat "$SCRATCH/watchdog.pid") hard deadline $(date -r "$HARD_DEADLINE" -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- supervise -----------------------------------------------------------
# TWO guards, because #116 adds a question #105 and #109 did not have.
#
#   GAIN GUARD, inherited from run109.sh: 250 MiB gained over five minutes
#   (50 MiB/min fleet-wide), twenty times below #86's ~1000 MiB/min signature.
#   It catches a runaway that has not yet got large.
#
#   ABSOLUTE RAM GUARD, new here and required by #116 in its own words: stop if
#   whole-machine bun RSS threatens a few GB. 3,072 MiB, the same number
#   analyze116.ts pre-registers, checked against the same sampled field. It
#   catches a fleet that is merely TOO BIG rather than accelerating — which is
#   the failure mode scaling N introduces and gain alone cannot see.
#
# Both write an ABORTED file. Aborting IS a result for this ticket, not a
# failure to produce one: #116 says a fleet that cannot be held is itself the
# finding, to be reported rather than pushed through.
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

  # The absolute guard is armed from the FIRST sample. A fleet already over
  # three gigabytes during warm-up is over three gigabytes.
  machine=$(tail -n 1 "$SCRATCH/fleet.jsonl" 2>/dev/null \
    | grep -o '"machineBunRssGiB":[0-9.]*' | grep -o '[0-9.]*')
  if [ -n "$machine" ]; then
    machine_mib=$(echo "$machine" | awk '{printf "%d", $1*1024}')
    if [ "$machine_mib" -ge "$RAM_GUARD_MIB" ]; then
      log "ABORT: whole-machine bun RSS ${machine_mib} MiB >= guard ${RAM_GUARD_MIB} MiB"
      echo "ram-guard machineBunRssMiB=${machine_mib} guard=${RAM_GUARD_MIB}" >"$SCRATCH/ABORTED"
      break
    fi
  fi

  [ "$(date +%s)" -lt "$GUARD_ARMED_AT" ] && continue
  window=$(tail -n "$GUARD_WINDOW" "$SCRATCH/fleet.jsonl" 2>/dev/null \
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

log "scale run loop finished"
