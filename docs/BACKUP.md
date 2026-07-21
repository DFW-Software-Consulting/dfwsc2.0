# Backup subsystem

The production stack uses a dedicated, locally built `dfwsc-backup` image that runs a scheduled Postgres dump to a Docker volume and optionally uploads it to an S3-compatible object store.

## Image

- `backup/Dockerfile` — multi-tool image with `pg_dump`, `aws-cli`, `supercronic`, and healthcheck scripts.
- `backup/scripts/backup.sh` — dumps the database, verifies the gzip archive, optionally uploads it, then writes a success heartbeat.
- `backup/scripts/restore.sh` — restores a backup only after explicit confirmation.
- `backup/scripts/healthcheck.sh` — checks the success heartbeat age.
- `backup/scripts/scheduler.sh` — foreground cron-like scheduler using `supercronic`.

## Environment variables

All variables are optional unless marked **required**.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | — | **Required.** Postgres connection string for the database to back up. |
| `BACKUP_SCHEDULE` | `0 2 * * *` | Cron expression for the backup schedule. |
| `BACKUP_RETENTION_DAYS` | `30` | Local retention in days. Set to `0` to keep forever. |
| `BACKUP_S3_BUCKET` | — | S3 bucket name. Upload is skipped if unset. Also accepts legacy `AWS_S3_BACKUP_BUCKET`. |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix inside the bucket. |
| `AWS_ACCESS_KEY_ID` | — | S3 access key. |
| `AWS_SECRET_ACCESS_KEY` | — | S3 secret key. |
| `AWS_DEFAULT_REGION` | `us-east-1` | S3 region. |
| `AWS_ENDPOINT_URL_S3` | — | S3-compatible endpoint (e.g. MinIO, R2, DigitalOcean Spaces). Also accepts `AWS_S3_ENDPOINT`. |
| `BACKUP_HEARTBEAT_MAX_AGE` | `90000` | Fail healthcheck if the last successful backup is older than this many seconds (default 25 h). |

## Makefile helpers

| Target | Purpose |
|--------|---------|
| `make backup-build` | Build the backup image. |
| `make backup-shell` | Open a shell in the backup container. |
| `make backup-now` | Run one backup immediately. |
| `make backup-list` | List local backups. |
| `make backup-restore FILE=...` | Restore a backup after explicit confirmation. |

## Manual backup run

```sh
make backup-now
```

Or with a specific `.env`:

```sh
docker compose -f docker-compose.prod.yml run --rm \
  --entrypoint /usr/local/bin/backup.sh backup
```

## Restore drill

1. Pick a backup to restore:

   ```sh
   make backup-list
   ```

2. Restore to the database configured by `DATABASE_URL`:

   ```sh
   make backup-restore FILE=/backups/postgres/20260102_030405_stripe_portal.sql.gz
   ```

   The script will prompt for the target database name and refuse to run unless you also set `RESTORE_CONFIRM=yes`.

3. For a non-interactive drill (CI / automation), use both flags:

   ```sh
   make backup-restore \
     FILE=/backups/postgres/20260102_030405_stripe_portal.sql.gz \
     RESTORE_CONFIRM=yes \
     RESTORE_NONINTERACTIVE=1
   ```

   **Restore drills should target a scratch database, never production.** The script still prints the target database and requires `RESTORE_CONFIRM=yes`.

4. Verify the restore:

   ```sh
   # Example: row counts in a key table
   psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM invoices;"
   ```

## Healthcheck

The container is healthy when `/backups/heartbeat` exists and is newer than `BACKUP_HEARTBEAT_MAX_AGE`. The heartbeat is only written after the local dump and the optional S3 upload both succeed, so a failing healthcheck means backups are not completing. The heartbeat lives on the same volume as the backups so it survives container restarts.

## Updating pinned versions

Tool versions are pinned in `backup/Dockerfile`. To refresh them after an Alpine update:

```sh
docker run --rm alpine:3.21.3 sh -c "apk update >/dev/null && apk search -x postgresql17-client && apk search -x aws-cli && apk search -x supercronic"
```

Then edit the `RUN apk add` line in `backup/Dockerfile`.
