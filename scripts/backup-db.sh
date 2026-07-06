#!/bin/bash
set -euo pipefail

# Backs up the production Postgres database.
#
# Production uses an EXTERNAL managed Postgres instance (there is no `db`
# service in docker-compose.prod.yml) — connect and dump directly via
# DATABASE_URL instead of `docker compose exec`.
#
# NOTE: this IS scheduled in production — the `backup` service in
# docker-compose.prod.yml runs this script nightly via its own cron entry
# (0 2 * * *), writing into the `postgres_backups` volume (and to S3 if
# AWS_S3_BACKUP_BUCKET is set). If invoking this script elsewhere (e.g. a
# Coolify scheduled task, a systemd timer, or a standalone cron entry), set
# DATABASE_URL and run it directly:
#   0 2 * * *  DATABASE_URL=... /path/to/scripts/backup-db.sh
# A periodic RESTORE DRILL (actually restoring a backup to a scratch DB) is
# strongly recommended — an untested backup is not a backup.

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL must be set to run this backup script." >&2
  exit 1
fi

BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/stripe_portal_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"

if [ -n "${AWS_S3_BACKUP_BUCKET:-}" ]; then
  aws s3 cp "$BACKUP_FILE" "s3://${AWS_S3_BACKUP_BUCKET}/backups/$(basename "$BACKUP_FILE")"
fi

find "$BACKUP_DIR" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "Backup complete: ${BACKUP_FILE}"
