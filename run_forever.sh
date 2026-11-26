#!/usr/bin/env bash
# Read-only polling loop. Waits 20 seconds after each completed scan.
set -euo pipefail
cd "$(dirname "$0")"
while true; do
  echo "[$(date -Is)] Starting scan"
  npm run scan || echo "[$(date -Is)] Scan failed; will retry"
  sleep "${SCAN_INTERVAL_SECONDS:-20}"
done
