#!/usr/bin/env bash
# WordWise backend control: start / stop / restart / status / logs / install / uninstall
#
# Usage:
#   ./scripts/wordwise.sh install     # register LaunchAgent (one-time)
#   ./scripts/wordwise.sh uninstall   # remove LaunchAgent
#   ./scripts/wordwise.sh start
#   ./scripts/wordwise.sh stop
#   ./scripts/wordwise.sh restart
#   ./scripts/wordwise.sh status
#   ./scripts/wordwise.sh logs        # tail supervisor + backend logs

set -e

LABEL="com.wordwise.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/wordwise"
PORT="8000"

cmd=${1:-status}

case "$cmd" in
  install)
    if [ ! -f "$PLIST" ]; then
      echo "❌ plist not found: $PLIST"
      echo "   Run setup first to create the LaunchAgent file."
      exit 1
    fi
    # Kill any leftover uvicorn from previous manual runs
    pkill -f "uvicorn main:app" 2>/dev/null || true
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || \
      launchctl load -w "$PLIST"
    echo "✅ LaunchAgent installed and started: $LABEL"
    echo "   Backend will auto-start on every login."
    ;;

  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || \
      launchctl unload -w "$PLIST" 2>/dev/null || true
    echo "✅ LaunchAgent uninstalled"
    ;;

  start)
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || {
      echo "⚠️  not registered yet, run: $0 install"
      exit 1
    }
    echo "✅ started"
    ;;

  stop)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    pkill -f "uvicorn main:app" 2>/dev/null || true
    pkill -f "run_backend.sh" 2>/dev/null || true
    echo "✅ stopped"
    ;;

  restart)
    "$0" stop
    sleep 2
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || \
      launchctl load -w "$PLIST"
    echo "✅ restarted"
    ;;

  status)
    echo "=== LaunchAgent ==="
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid|last exit|on demand" | head -10
    else
      echo "  not registered"
    fi
    echo ""
    echo "=== Backend health ==="
    if curl -sf -m 3 "http://127.0.0.1:$PORT/api/dict-packs/" > /dev/null 2>&1; then
      echo "  ✅ http://localhost:$PORT  (responsive)"
    else
      echo "  ❌ http://localhost:$PORT  (not responding)"
    fi
    echo ""
    echo "=== Recent processes ==="
    ps aux | grep -E "uvicorn main|run_backend" | grep -v grep || echo "  (none)"
    ;;

  logs)
    echo "=== Tailing logs (Ctrl+C to exit) ==="
    echo "  $LOG_DIR/supervisor.out, supervisor.err, backend.out, backend.err"
    echo ""
    tail -f \
      "$LOG_DIR/supervisor.out" \
      "$LOG_DIR/supervisor.err" \
      "$LOG_DIR/backend.out" \
      "$LOG_DIR/backend.err" 2>/dev/null
    ;;

  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
