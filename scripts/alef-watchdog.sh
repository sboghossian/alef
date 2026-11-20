#!/bin/bash
# alef-watchdog: brings the live Alef back after a reboot or a crash. Run by launchd every 5 minutes
# (hooks/launchd/com.stephane.alef-watchdog.plist.example; install steps in hooks/install.md).
#
#   API :5179 answers GET /api/health with 200   → nothing to do, nothing logged
#   not 200 AND nothing listens on :5179         → $HOME/.alef-loop/bin/alef-live start, one log line
#   not 200 BUT something listens on :5179       → leave it alone (it may be booting, or not ours), one log line
#
# It never kills anything, never restarts a server that is listening, and always exits 0 (a watchdog
# that exits non-zero would read as a failing routine in Health). Everything is an absolute path with an
# explicit PATH: launchd starts it without a login shell. It never reads ~/Documents itself (a launchd
# job that touches ~/Documents can exit 127 or get EPERM from macOS privacy controls); alef-live runs
# the server from ~/.alef-live.
set -u

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
HOME="${HOME:-/Users/$(/usr/bin/id -un)}"
export HOME

# ALEF_WATCHDOG_PORT exists for the script's own tests (a throwaway port); launchd never sets it.
PORT="${ALEF_WATCHDOG_PORT:-5179}"
LIVE_CMD="$HOME/.alef-loop/bin/alef-live"
LOG_DIR="$HOME/Library/Logs/alef"
LOG="$LOG_DIR/watchdog.log"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

/bin/mkdir -p "$LOG_DIR" 2>/dev/null || true
# Keep the log small: past 1 MB the newest 500 lines stay.
if [ -f "$LOG" ] && [ "$(/usr/bin/stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  /usr/bin/tail -n 500 "$LOG" >"$LOG.tmp" 2>/dev/null && /bin/mv "$LOG.tmp" "$LOG"
fi

log() {
  printf '%s %s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG" 2>/dev/null || true
}

status_code() {
  /usr/bin/curl -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true
}

code="$(status_code)"
[ "$code" = "200" ] && exit 0

# lsof is /usr/sbin/lsof on macOS and /usr/bin/lsof on Linux (CI): found through the PATH above.
# Without lsof at all, a bare TCP connect tells whether anything listens.
listening() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

if listening; then
  log "api=${code:-none}: :$PORT is listening, so not starting anything (booting, or not ours)"
  exit 0
fi

if [ ! -x "$LIVE_CMD" ]; then
  log "api=${code:-none}, :$PORT free: $LIVE_CMD is missing or not executable, nothing started"
  exit 0
fi

# alef-live leaves the server and vite in THIS job's process group; the plist's AbandonProcessGroup is what
# stops launchd from killing them when this script exits.
"$LIVE_CMD" start </dev/null >/dev/null 2>&1
rc=$?
log "api=${code:-none}, :$PORT free: ran alef-live start (exit $rc), api now $(status_code)"
exit 0
