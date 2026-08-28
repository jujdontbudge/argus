#!/bin/bash
# #117 item 5: fill a filesystem under a live archiver and find out whether the
# failure is LOUD and BOUNDED.
#
# ---------------------------------------------------------------------------
# BLAST RADIUS, WHICH IS THE ONLY REASON THIS IS SHAPED THIS WAY
# ---------------------------------------------------------------------------
# The house rule is: never touch the real disk's free space in a way that could
# affect Johan's actual machine capacity, and if the blast radius cannot be
# cleanly bounded, skip the scenario and say so rather than improvise.
#
# So nothing here fills a real filesystem. A 20 MiB HFS+ disk IMAGE is created
# under /private/tmp and attached at an explicit mountpoint, also under
# /private/tmp, with -nobrowse so it never appears in Finder. Filling that
# volume to ENOSPC consumes the image's 20 MiB and not one byte more: the image
# file is a fixed-size file that was already allocated before the first write.
# The peak cost to Johan's real disk is therefore 20 MiB, known in advance,
# whatever the archiver does.
#
# -nomount ram:// was rejected: `diskutil erasevolume` mounts a RAM disk at
# /Volumes with no way to redirect it that does not need sudo, and a scenario
# that needs sudo to clean up after itself is not bounded.
#
# DETACH IS BY THE DEVICE NODE THIS SCRIPT CAPTURED, never by volume name and
# never by scanning `hdiutil info` for something that looks like ours. It runs
# from a trap so an interrupted run still detaches, and it is idempotent.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/.." && cd .. && pwd)"
BUN="$(command -v bun)"

SIZE_MB="${ARGUS_CHAOS_VOLUME_MB:-20}"
OBSERVE_S="${ARGUS_CHAOS_DISKFULL_OBSERVE_S:-90}"
SETTLE_S=25

SCRATCH="$(mktemp -d /private/tmp/argus-chaos-disk-XXXXXX)"
IMAGE="$SCRATCH/volume.dmg"
MNT="$SCRATCH/mnt"
DEVICE=""
mkdir -p "$MNT"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$SCRATCH/diskfull.log"; }

teardown() {
  # Idempotent, and safe to run twice — the same discipline reap.sh applies to
  # pids, applied to a device node.
  if [ -n "$DEVICE" ]; then
    hdiutil detach "$DEVICE" -force >>"$SCRATCH/diskfull.log" 2>&1 && DEVICE=""
  fi
}
trap 'teardown' EXIT INT TERM

log "scratch=$SCRATCH size=${SIZE_MB}MiB observe=${OBSERVE_S}s"

hdiutil create -size "${SIZE_MB}m" -fs HFS+ -volname ArgusChaos117 -quiet "$IMAGE" || {
  log "SKIPPED: could not create the disk image; refusing to improvise on the real filesystem"
  exit 3
}
ATTACH="$(hdiutil attach "$IMAGE" -mountpoint "$MNT" -nobrowse 2>&1)"
DEVICE="$(echo "$ATTACH" | awk '/^\/dev\// { print $1; exit }')"
if [ -z "$DEVICE" ] || [ ! -d "$MNT" ]; then
  log "SKIPPED: attach failed: $ATTACH"
  exit 3
fi
log "attached $DEVICE at $MNT"
df -m "$MNT" | tee -a "$SCRATCH/diskfull.log"

# The repo — and therefore .argus/archive.db — lives ON the small volume. HOME
# stays on the big one: this scenario is about the archive's filesystem filling,
# not about the transcripts' filesystem filling, and mixing the two would make
# any failure unattributable.
REPO="$MNT/repo"
HOME_DIR="$SCRATCH/home"
mkdir -p "$REPO/.argus" "$HOME_DIR/.codex/sessions/2026/08/28" "$HOME_DIR/.claude/projects" "$HOME_DIR/.hermes"
git init --quiet "$REPO"
printf 'brain:\n  model: argus-chaos-invalid\n' >"$REPO/.argus/config.yaml"
printf 'url: http://127.0.0.1:1\nworkspace: argus-chaos-117-diskfull\n' >"$REPO/.argus/honcho.yaml"
REAL_REPO="$(cd "$REPO" && pwd -P)"
printf '%s\n' "$REAL_REPO" >"$SCRATCH/argus-repos"

ROLLOUT="$HOME_DIR/.codex/sessions/2026/08/28/rollout-2026-08-28T00-00-00-00000000-0000-0000-1170-000000117009.jsonl"
printf '{"timestamp":"2026-08-28T00:00:00.000Z","type":"session_meta","payload":{"id":"00000000-0000-0000-1170-000000117009","session_id":"00000000-0000-0000-1170-000000117009","cwd":"%s","cli_version":"0.149.0"}}\n' "$REAL_REPO" >"$ROLLOUT"

export HOME="$HOME_DIR"
export CODEX_HOME="$HOME_DIR/.codex"
export CLAUDE_CONFIG_DIR="$HOME_DIR/.claude"
export HERMES_HOME="$HOME_DIR/.hermes"
export ARGUS_REPOS_FILE="$SCRATCH/argus-repos"
# R4 again: the watcher polls this pid and exits by itself if this driver dies,
# so teardown never depends on the trap above actually getting to run.
export ARGUS_WATCH_OWNER_PID=$$

"$BUN" "$SRC/src/cli.ts" watch archiver --repo "$REAL_REPO" \
  >>"$SCRATCH/watcher.stdout" 2>>"$SCRATCH/watcher.stderr" &
WATCHER=$!
echo "$WATCHER" >"$SCRATCH/watcher.pid"
log "archiver pid $WATCHER"

emit() { # <ordinal>
  printf '{"timestamp":"%s","ordinal":%s,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"diskfull117 probe %s argus watcher archiver sqlite backlog"}]}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$1" >>"$ROLLOUT"
}

rows() {
  "$BUN" -e '
    import { Database } from "bun:sqlite";
    try {
      const db = new Database(process.argv[2], { readonly: true, strict: true });
      console.log(db.query("SELECT count(*) AS c FROM archive_messages").get().c);
      db.close();
    } catch (error) { console.log(`ERR ${error.message}`); }
  ' "$REAL_REPO/.argus/archive.db" 2>/dev/null
}

ORDINAL=1
END=$(( $(date +%s) + SETTLE_S ))
while [ "$(date +%s)" -lt "$END" ]; do emit "$ORDINAL"; ORDINAL=$(( ORDINAL + 1 )); sleep 1; done
ROWS_BEFORE="$(rows)"
log "settled rows=$ROWS_BEFORE"
df -m "$MNT" | tail -1 | tee -a "$SCRATCH/diskfull.log"

# ---- fill it -------------------------------------------------------------
# `dd` to ENOSPC. The ballast is one file so freeing it later is one `rm`, and
# it cannot outlive the volume it lives on.
log "filling $MNT to capacity"
dd if=/dev/zero of="$MNT/ballast" bs=1m 2>>"$SCRATCH/diskfull.log"
FILLED_AT=$(date +%s)
df -m "$MNT" | tail -1 | tee -a "$SCRATCH/diskfull.log"
log "ENOSPC reached; observing ${OBSERVE_S}s"

STDERR_AT_FILL=$(wc -l <"$SCRATCH/watcher.stderr" | tr -d ' ')
END=$(( FILLED_AT + OBSERVE_S ))
while [ "$(date +%s)" -lt "$END" ]; do
  emit "$ORDINAL"; ORDINAL=$(( ORDINAL + 1 ))
  sleep 5
  printf '%s rows=%s stderrLines=%s rss=%s\n' \
    "$(( $(date +%s) - FILLED_AT ))" "$(rows)" \
    "$(wc -l <"$SCRATCH/watcher.stderr" | tr -d ' ')" \
    "$(ps -o rss= -p "$WATCHER" 2>/dev/null | tr -d ' ')" >>"$SCRATCH/full-timeline.txt"
done
ROWS_FULL="$(rows)"
STDERR_WHILE_FULL=$(( $(wc -l <"$SCRATCH/watcher.stderr" | tr -d ' ') - STDERR_AT_FILL ))
HEALTH_FULL="$(cat "$REAL_REPO/.argus/eyes/archiver/health.json" 2>/dev/null | tr -d '\n')"
log "while full: rows=$ROWS_FULL newStderrLines=$STDERR_WHILE_FULL (over ${OBSERVE_S}s)"

# ---- give the space back -------------------------------------------------
rm -f "$MNT/ballast"
FREED_AT=$(date +%s)
df -m "$MNT" | tail -1 | tee -a "$SCRATCH/diskfull.log"
log "space returned; observing recovery ${OBSERVE_S}s"
END=$(( FREED_AT + OBSERVE_S ))
while [ "$(date +%s)" -lt "$END" ]; do
  emit "$ORDINAL"; ORDINAL=$(( ORDINAL + 1 ))
  sleep 5
  printf '%s rows=%s\n' "$(( $(date +%s) - FREED_AT ))" "$(rows)" >>"$SCRATCH/recovery-timeline.txt"
done
ROWS_RECOVERED="$(rows)"
INTEGRITY="$("$BUN" -e '
  import { Database } from "bun:sqlite";
  try {
    const db = new Database(process.argv[2], { readonly: true, strict: true });
    console.log(Object.values(db.query("PRAGMA integrity_check").get())[0]);
    db.close();
  } catch (error) { console.log(`ERR ${error.message}`); }
' "$REAL_REPO/.argus/archive.db" 2>/dev/null)"
HEALTH_END="$(cat "$REAL_REPO/.argus/eyes/archiver/health.json" 2>/dev/null | tr -d '\n')"

kill -TERM "$WATCHER" 2>/dev/null
wait "$WATCHER" 2>/dev/null
EXIT_CODE=$?

cat >"$SCRATCH/diskfull-result.json" <<JSON
{
  "ticket": 117,
  "scenario": "disk-full",
  "volumeMiB": $SIZE_MB,
  "mountpoint": "$MNT",
  "device": "$DEVICE",
  "observeSeconds": $OBSERVE_S,
  "rowsBeforeFill": "$ROWS_BEFORE",
  "rowsWhileFull": "$ROWS_FULL",
  "rowsAfterSpaceReturned": "$ROWS_RECOVERED",
  "newStderrLinesWhileFull": $STDERR_WHILE_FULL,
  "integrityAfter": "$INTEGRITY",
  "watcherExitCode": $EXIT_CODE,
  "healthWhileFull": $( [ -n "$HEALTH_FULL" ] && echo "$HEALTH_FULL" || echo null ),
  "healthAtEnd": $( [ -n "$HEALTH_END" ] && echo "$HEALTH_END" || echo null )
}
JSON
log "result written to $SCRATCH/diskfull-result.json"
cat "$SCRATCH/diskfull-result.json"
echo "$SCRATCH" >"$SRC/.diskfull-scratch"
