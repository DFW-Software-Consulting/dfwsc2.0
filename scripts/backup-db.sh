#!/bin/bash
set -euo pipefail

BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/stripe_portal_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres stripe_portal | gzip > "$BACKUP_FILE"

if [ -n "${AWS_S3_BACKUP_BUCKET:-}" ]; then
  aws s3 cp "$BACKUP_FILE" "s3://${AWS_S3_BACKUP_BUCKET}/backups/$(basename "$BACKUP_FILE")"
fi

find "$BACKUP_DIR" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "Backup complete: ${BACKUP_FILE}"
