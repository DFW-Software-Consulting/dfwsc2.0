#!/bin/bash
set -euo pipefail

# Container healthcheck: fail if the backup success heartbeat is missing or stale.
# The heartbeat is only written after both the local dump and optional S3 upload
# succeed, so a stale/missing heartbeat means backups are not healthy.

BACKUP_HEARTBEAT_PATH="${BACKUP_HEARTBEAT_PATH:-/backups/heartbeat}"
BACKUP_HEARTBEAT_MAX_AGE="${BACKUP_HEARTBEAT_MAX_AGE:-90000}" # 25 hours (daily + slack)

if [ ! -f "$BACKUP_HEARTBEAT_PATH" ]; then
  echo "[healthcheck] FAIL: heartbeat not found at ${BACKUP_HEARTBEAT_PATH}"
  exit 1
fi

LAST_BEAT=$(stat -c %Y "$BACKUP_HEARTBEAT_PATH")
NOW=$(date +%s)
AGE=$((NOW - LAST_BEAT))

if [ "$AGE" -gt "$BACKUP_HEARTBEAT_MAX_AGE" ]; then
  echo "[healthcheck] FAIL: heartbeat is ${AGE}s old (max ${BACKUP_HEARTBEAT_MAX_AGE}s)"
  exit 1
fi

echo "[healthcheck] OK: heartbeat is ${AGE}s old"
