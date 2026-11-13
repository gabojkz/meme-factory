#!/usr/bin/env bash
# Launches a built MemeFactory binary and checks it starts and keeps running.
# Catches apps that crash or panic on launch before they reach a release.
#
# Usage: scripts/smoke-test.sh <path-to-binary> [seconds]
# Set SMOKE_PREFIX to wrap the launch, e.g. SMOKE_PREFIX="xvfb-run -a" on Linux CI.
set -uo pipefail

BIN="${1:?Usage: scripts/smoke-test.sh <path-to-binary> [seconds]}"
WAIT="${2:-20}"

if [[ ! -f "$BIN" ]]; then
  echo "✗ Binary not found: $BIN"
  exit 1
fi

LOG="$(mktemp)"
echo "→ Launching $BIN for ${WAIT}s"
# shellcheck disable=SC2086 # SMOKE_PREFIX is intentionally word-split
${SMOKE_PREFIX:-} "$BIN" >"$LOG" 2>&1 &
PID=$!

alive() { kill -0 "$PID" 2>/dev/null; }

for ((i = 0; i < WAIT; i++)); do
  if ! alive; then
    wait "$PID"
    CODE=$?
    echo "✗ The app exited after ${i}s (exit code $CODE). Output:"
    cat "$LOG"
    exit 1
  fi
  sleep 1
done

# Stop it (and anything it started, such as xvfb-run's child).
kill "$PID" 2>/dev/null || true
pkill -P "$PID" 2>/dev/null || true
sleep 1
kill -9 "$PID" 2>/dev/null || true

if grep -qiE "panicked at|fatal runtime error" "$LOG"; then
  echo "✗ The app panicked while starting. Output:"
  cat "$LOG"
  exit 1
fi

echo "✓ The app started and kept running for ${WAIT}s"
if [[ -s "$LOG" ]]; then
  echo "Output:"
  cat "$LOG"
fi
