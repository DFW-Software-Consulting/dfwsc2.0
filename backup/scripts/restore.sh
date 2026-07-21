#!/bin/bash
set -euo pipefail

# Safe restore script for the production Postgres backup image.
# Requires explicit confirmation before overwriting a database.
#
# Usage examples:
#   # From a local backup file inside the container
#   restore.sh /backups/postgres/20260102_030405_stripe_portal.sql.gz
#
#   # From S3 (when BACKUP_S3_BUCKET is set)
#   restore.sh s3://my-bucket/backups/20260102_030405_stripe_portal.sql.gz
#   restore.sh 20260102_030405_stripe_portal.sql.gz
#
# One-off with Docker Compose:
#   make backup-restore FILE=/backups/postgres/20260102_030405_stripe_portal.sql.gz RESTORE_CONFIRM=1

: "${DATABASE_URL:?DATABASE_URL must be set}"

BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-${AWS_S3_BACKUP_BUCKET:-}}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/}"
AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-${AWS_S3_ENDPOINT:-}}"
RESTORE_CONFIRM="${RESTORE_CONFIRM:-}"
RESTORE_NONINTERACTIVE="${RESTORE_NONINTERACTIVE:-}"

SOURCE="${1:-}"

usage() {
  cat <<EOF
Usage: $0 <local-file.sql.gz | s3://bucket/prefix/file.sql.gz | basename.sql.gz>

Environment:
  DATABASE_URL            Target Postgres database (required)
  RESTORE_CONFIRM=yes     Acknowledge that this will overwrite the target DB
  RESTORE_NONINTERACTIVE=1 Skip interactive prompts (requires RESTORE_CONFIRM=yes)
  BACKUP_S3_BUCKET        Required when restoring from a basename
  BACKUP_S3_PREFIX        Optional S3 key prefix (default: backups/)
  AWS_ENDPOINT_URL_S3     Optional S3-compatible endpoint

EOF
}

if [ -z "$SOURCE" ]; then
  usage >&2
  echo "Available local backups:" >&2
  ls -1t /backups/postgres/*.sql.gz 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

# Resolve the backup file: local path, s3:// URL, or basename to download.
LOCAL_FILE=""
if [ -f "$SOURCE" ]; then
  LOCAL_FILE="$SOURCE"
elif printf '%s' "$SOURCE" | grep -q '^s3://'; then
  LOCAL_FILE="/tmp/restore-$(basename "$SOURCE")"
  echo "[restore] Downloading ${SOURCE} -> ${LOCAL_FILE}"
  if [ -n "$AWS_ENDPOINT_URL_S3" ]; then
    aws s3 cp "$SOURCE" "$LOCAL_FILE" --endpoint-url "$AWS_ENDPOINT_URL_S3"
  else
    aws s3 cp "$SOURCE" "$LOCAL_FILE"
  fi
elif [ -n "$BACKUP_S3_BUCKET" ]; then
  S3_PREFIX="${BACKUP_S3_PREFIX%/}/"
  S3_SOURCE="s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}${SOURCE}"
  LOCAL_FILE="/tmp/restore-${SOURCE}"
  echo "[restore] Downloading ${S3_SOURCE} -> ${LOCAL_FILE}"
  if [ -n "$AWS_ENDPOINT_URL_S3" ]; then
    aws s3 cp "$S3_SOURCE" "$LOCAL_FILE" --endpoint-url "$AWS_ENDPOINT_URL_S3"
  else
    aws s3 cp "$S3_SOURCE" "$LOCAL_FILE"
  fi
else
  echo "[restore] ERROR: not a local file, s3:// URL, and BACKUP_S3_BUCKET is not set: ${SOURCE}" >&2
  exit 1
fi

if [ ! -f "$LOCAL_FILE" ] || [ ! -s "$LOCAL_FILE" ]; then
  echo "[restore] ERROR: backup file missing or empty: ${LOCAL_FILE}" >&2
  exit 1
fi

# Identify the actual target database name.
TARGET_DB=$(psql "$DATABASE_URL" -At -c "SELECT current_database();" 2>/dev/null || true)
if [ -z "$TARGET_DB" ]; then
  echo "[restore] ERROR: could not determine target database from DATABASE_URL" >&2
  exit 1
fi

BACKUP_SIZE=$(du -h "$LOCAL_FILE" | cut -f1)
BACKUP_MTIME=$(date -r "$LOCAL_FILE" '+%Y-%m-%d %H:%M:%S %Z')

cat <<EOF

[restore] RESTORE REQUESTED
  Source file:  ${SOURCE}
  Local path:   ${LOCAL_FILE}
  Size:         ${BACKUP_SIZE}
  Modified:     ${BACKUP_MTIME}
  Target DB:    ${TARGET_DB}
  DATABASE_URL: ${DATABASE_URL//:*@/@******@}

This will DROP and RECREATE objects in the target database.
EOF

# ---------------------------------------------------------------------------
# Confirmation gate
# ---------------------------------------------------------------------------
confirm_env_ok() {
  case "$RESTORE_CONFIRM" in
    yes|YES|1|true|TRUE) return 0 ;;
    *) return 1 ;;
  esac
}

if ! confirm_env_ok; then
  echo "[restore] ERROR: RESTORE_CONFIRM is not set to 'yes'. Aborting." >&2
  exit 1
fi

if [ -t 0 ] && [ -z "$RESTORE_NONINTERACTIVE" ]; then
  echo
  echo "Type the target database name '${TARGET_DB}' to confirm:"
  read -r typed
  if [ "$typed" != "$TARGET_DB" ]; then
    echo "[restore] ERROR: confirmation did not match. Aborting." >&2
    exit 1
  fi
fi

echo "[restore] Restoring to ${TARGET_DB} ..."
gunzip -c "$LOCAL_FILE" | psql "$DATABASE_URL"

echo "[restore] Restore complete: ${TARGET_DB}"
