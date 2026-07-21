#!/bin/bash
set -euo pipefail

# Production Postgres backup to local volume + optional S3-compatible object store.
# Writes a success heartbeat ONLY after the local dump is valid and the optional
# remote upload succeeds. Exit non-zero on any failure so the scheduler/healthcheck
# surface the problem.

: "${DATABASE_URL:?DATABASE_URL must be set}"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-${AWS_S3_BACKUP_BUCKET:-}}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/}"
BACKUP_HEARTBEAT_PATH="${BACKUP_HEARTBEAT_PATH:-/backups/heartbeat}"
AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-${AWS_S3_ENDPOINT:-}}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_NAME=$(printf '%s\n' "$DATABASE_URL" | sed -n 's#^[^/]*//[^/]*/\([^?]*\).*#\1#p')
DB_NAME="${DB_NAME:-database}"
BACKUP_FILE="${BACKUP_DIR}/${TIMESTAMP}_${DB_NAME}.sql.gz"

echo "[backup] Starting backup of ${DB_NAME} at ${TIMESTAMP}"

mkdir -p "$BACKUP_DIR"
mkdir -p "$(dirname "$BACKUP_HEARTBEAT_PATH")"

# ---------------------------------------------------------------------------
# Local dump
# ---------------------------------------------------------------------------
echo "[backup] Running pg_dump -> ${BACKUP_FILE}"
pg_dump \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  "$DATABASE_URL" | gzip > "$BACKUP_FILE"

if [ ! -s "$BACKUP_FILE" ]; then
  echo "[backup] ERROR: backup file is empty" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

echo "[backup] Verifying gzip integrity"
gzip -t "$BACKUP_FILE"

# ---------------------------------------------------------------------------
# Optional remote upload
# ---------------------------------------------------------------------------
if [ -n "$BACKUP_S3_BUCKET" ]; then
  # Normalize prefix so it ends with exactly one slash.
  S3_PREFIX="${BACKUP_S3_PREFIX%/}/"
  S3_KEY="s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}$(basename "$BACKUP_FILE")"

  echo "[backup] Uploading to ${S3_KEY}"
  if [ -n "$AWS_ENDPOINT_URL_S3" ]; then
    aws s3 cp "$BACKUP_FILE" "$S3_KEY" --endpoint-url "$AWS_ENDPOINT_URL_S3"
  else
    aws s3 cp "$BACKUP_FILE" "$S3_KEY"
  fi
  echo "[backup] Upload complete"
fi

# ---------------------------------------------------------------------------
# Success heartbeat (written only after local + remote succeed)
# ---------------------------------------------------------------------------
date -Iseconds > "$BACKUP_HEARTBEAT_PATH"
echo "[backup] Heartbeat written to ${BACKUP_HEARTBEAT_PATH}"

# ---------------------------------------------------------------------------
# Local retention cleanup
# ---------------------------------------------------------------------------
if [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  echo "[backup] Pruning local backups older than ${BACKUP_RETENTION_DAYS} days"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.sql.gz" -mtime +"${BACKUP_RETENTION_DAYS}" -delete
else
  echo "[backup] Local retention disabled (BACKUP_RETENTION_DAYS=0)"
fi

echo "[backup] Success: ${BACKUP_FILE}"
