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
BACKUP_REQUIRE_REMOTE="${BACKUP_REQUIRE_REMOTE:-}"
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
# Dump to a temporary name and rename only after the dump and gzip -t both
# succeed, so a failed or truncated dump can never leave a normal-looking
# <timestamp>_<db>.sql.gz that restore.sh and `make backup-list` would pick up.
# The temp name does not match *.sql.gz. It is removed on any exit.
PARTIAL_FILE="${BACKUP_FILE}.partial"
trap 'rm -f "$PARTIAL_FILE"' EXIT

echo "[backup] Running pg_dump -> ${BACKUP_FILE}"
if ! pg_dump \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  "$DATABASE_URL" | gzip > "$PARTIAL_FILE"; then
  echo "[backup] ERROR: pg_dump failed; no backup file was kept" >&2
  exit 1
fi

if [ ! -s "$PARTIAL_FILE" ]; then
  echo "[backup] ERROR: backup file is empty" >&2
  exit 1
fi

echo "[backup] Verifying gzip integrity"
if ! gzip -t "$PARTIAL_FILE"; then
  echo "[backup] ERROR: gzip integrity check failed; no backup file was kept" >&2
  exit 1
fi

mv "$PARTIAL_FILE" "$BACKUP_FILE"

# ---------------------------------------------------------------------------
# Local retention cleanup
# Runs before the remote upload so a run that fails there still prunes old dumps.
# A failed prune must not stop the fresh dump from being uploaded, so it is
# recorded here and reported after the upload and heartbeat.
# ---------------------------------------------------------------------------
PRUNE_FAILED=0

# Sweep partial dumps left behind by a killed run (the EXIT trap cannot run on SIGKILL).
if ! find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.sql.gz.partial" -mmin +1440 -delete; then
  PRUNE_FAILED=1
fi

if [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  echo "[backup] Pruning local backups older than ${BACKUP_RETENTION_DAYS} days"
  if ! find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.sql.gz" -mtime +"${BACKUP_RETENTION_DAYS}" -delete; then
    PRUNE_FAILED=1
  fi
else
  echo "[backup] Local retention disabled (BACKUP_RETENTION_DAYS=0)"
fi

if [ "$PRUNE_FAILED" -eq 1 ]; then
  echo "[backup] WARNING: local retention cleanup failed; continuing" >&2
fi

# ---------------------------------------------------------------------------
# Optional remote upload
# ---------------------------------------------------------------------------
if [ -z "$BACKUP_S3_BUCKET" ]; then
  case "$BACKUP_REQUIRE_REMOTE" in
    yes|YES|1|true|TRUE)
      echo "[backup] ERROR: BACKUP_REQUIRE_REMOTE is set but no S3 bucket is configured" >&2
      echo "[backup] Local dump kept at ${BACKUP_FILE}; no heartbeat written" >&2
      exit 1
      ;;
  esac
  echo "[backup] WARNING: no S3 bucket configured; backup is local only" >&2
fi

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

if [ "$PRUNE_FAILED" -eq 1 ]; then
  echo "[backup] ERROR: backup succeeded but local retention cleanup failed" >&2
  exit 1
fi

echo "[backup] Success: ${BACKUP_FILE}"
