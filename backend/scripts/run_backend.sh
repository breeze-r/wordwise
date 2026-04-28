#!/usr/bin/env bash
# WordWise backend supervisor.
# Designed to be invoked by launchd. We do NOT use uvicorn --reload here
# because launchd handles process restart, and --reload's file watcher dies
# silently on long-lived processes (the bug that bit us at 13 days uptime).

set -e

PROJECT_ROOT="/Users/ethan/Cursor/wordwise"
BACKEND_DIR="$PROJECT_ROOT/backend"
PYTHON_BIN="/Library/Frameworks/Python.framework/Versions/3.14/bin/python3"
HOST="0.0.0.0"
PORT="8000"
LOG_DIR="$HOME/Library/Logs/wordwise"
HEALTH_PROBE_INTERVAL=60       # seconds between probes
HEALTH_FAIL_THRESHOLD=3        # consecutive failures before restart

mkdir -p "$LOG_DIR"

cd "$BACKEND_DIR"

# Pick the python that has uvicorn installed.
# Prefer venv if it has uvicorn, otherwise fall back to system Python 3.14.
if [ -x "$BACKEND_DIR/.venv/bin/python" ] && \
   "$BACKEND_DIR/.venv/bin/python" -c "import uvicorn" 2>/dev/null; then
  PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"
elif "$PYTHON_BIN" -c "import uvicorn" 2>/dev/null; then
  : # system Python 3.14 already has uvicorn
else
  echo "[supervisor] FATAL: no Python with uvicorn found" >&2
  exit 1
fi

# Start uvicorn in background
log_main () {
  # Write to stdout (captured into supervisor.out by launchd) but flush.
  # Important: do NOT call log_main inside command substitutions —
  # the captured $(...) would swallow the log line into the variable.
  printf '[%s] [supervisor] %s\n' "$(date '+%F %T')" "$*"
}

start_uvicorn () {
  # Output ONLY the PID; logging happens in the caller.
  "$PYTHON_BIN" -m uvicorn main:app --host "$HOST" --port "$PORT" \
    >> "$LOG_DIR/backend.out" 2>> "$LOG_DIR/backend.err" &
  echo $!
}

log_main "starting uvicorn on $HOST:$PORT"
UVICORN_PID=$(start_uvicorn)
log_main "uvicorn pid=$UVICORN_PID"

# Cleanup on signal
trap 'log_main "got signal, stopping uvicorn pid=$UVICORN_PID"; kill $UVICORN_PID 2>/dev/null || true; exit 0' TERM INT

fail_count=0

while true; do
  sleep "$HEALTH_PROBE_INTERVAL"

  # 1. Is the process still alive at all?
  if ! kill -0 "$UVICORN_PID" 2>/dev/null; then
    log_main "uvicorn pid=$UVICORN_PID exited; restarting"
    UVICORN_PID=$(start_uvicorn)
    log_main "uvicorn restarted pid=$UVICORN_PID"
    fail_count=0
    continue
  fi

  # 2. Health probe
  if curl -sf -m 5 "http://127.0.0.1:$PORT/api/dict-packs/" > /dev/null 2>&1; then
    if [ "$fail_count" -gt 0 ]; then
      log_main "health probe recovered after $fail_count failure(s)"
    fi
    fail_count=0
  else
    fail_count=$((fail_count + 1))
    log_main "health probe failed ($fail_count/$HEALTH_FAIL_THRESHOLD)"
    if [ "$fail_count" -ge "$HEALTH_FAIL_THRESHOLD" ]; then
      log_main "health probe failed $fail_count times — killing pid=$UVICORN_PID and restarting"
      kill "$UVICORN_PID" 2>/dev/null || true
      sleep 2
      kill -9 "$UVICORN_PID" 2>/dev/null || true
      UVICORN_PID=$(start_uvicorn)
      log_main "uvicorn restarted pid=$UVICORN_PID"
      fail_count=0
    fi
  fi
done
