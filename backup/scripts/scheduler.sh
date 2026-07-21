#!/bin/bash
set -euo pipefail

# Foreground scheduler for the backup container. Keeps the container in the
# foreground so logs are visible to Docker, and prevents overlapping backup runs
# with a file lock.

SCHEDULE="${BACKUP_SCHEDULE:-0 2 * * *}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/tmp/backup.lock}"
CRONTAB="/tmp/crontab"

echo "[scheduler] Schedule: ${SCHEDULE}"
echo "[scheduler] Writing crontab to ${CRONTAB}"

echo "${SCHEDULE} /usr/bin/flock -n ${LOCK_FILE} /usr/local/bin/backup.sh" > "$CRONTAB"

exec supercronic "$CRONTAB"
