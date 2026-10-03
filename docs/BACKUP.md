# Backup subsystem

The production stack uses a dedicated, locally built `dfwsc-backup` image that runs a scheduled Postgres dump to a Docker volume and optionally uploads it to an S3-compatible object store.

## Image

- `backup/Dockerfile` — multi-tool image with `pg_dump`, `aws-cli`, `supercronic`, and healthcheck scripts.
- `backup/scripts/backup.sh` — dumps the database to a `.partial` temp file, renames it to `<timestamp>_<db>.sql.gz` only after the dump and `gzip -t` succeed (a failed dump never leaves a normal-looking file), optionally uploads it, then writes a success heartbeat.
- `backup/scripts/restore.sh` — checks the archive with `gzip -t`, restores only after explicit confirmation, and runs `psql` with `ON_ERROR_STOP` in a single transaction so the first SQL error aborts and rolls back.
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
| `BACKUP_REQUIRE_REMOTE` | — | Opt-in strictness. Set to `yes` (or `1`/`true`) to make a run fail, with no heartbeat, when no S3 bucket is configured. The local dump is still kept. Unset keeps the default: local-only backups with a warning. |
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
   make backup-restore FILE=/backups/postgres/20260102_030405_stripe_portal.sql.gz RESTORE_CONFIRM=yes
   ```

   The Makefile passes `RESTORE_CONFIRM` and `RESTORE_NONINTERACTIVE` into the container with `-e`. Without `RESTORE_CONFIRM=yes` the script aborts before writing anything. On a terminal it also prompts you to type the target database name.

3. For a non-interactive drill (CI / automation), use both flags:

   ```sh
   make backup-restore \
     FILE=/backups/postgres/20260102_030405_stripe_portal.sql.gz \
     RESTORE_CONFIRM=yes \
     RESTORE_NONINTERACTIVE=1
   ```

   **Restore drills should target a scratch database, never production.** The script still prints the target database and requires `RESTORE_CONFIRM=yes`.

   On Coolify there is no Makefile checkout. Run the script inside the running backup container instead (find its name with `docker ps --filter name=backup`):

   ```sh
   docker exec -it -e RESTORE_CONFIRM=yes <backup-container> \
     restore.sh /backups/postgres/20260102_030405_stripe_portal.sql.gz
   ```

   `DATABASE_URL` is the container's own, so to restore into a scratch database add `-e DATABASE_URL=postgres://user:pass@host:5432/scratch`.

   A restore stops at the first SQL error and rolls back, so a failed restore leaves the target as it was; it exits non-zero instead of printing "Restore complete". A corrupt or truncated archive is rejected before anything is written. Dumps are made with `--clean --if-exists`, so restore into a freshly created empty database where possible.

4. Verify the restore:

   ```sh
   # Example: row counts in key tables
   psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM clients;" -c "SELECT COUNT(*) FROM payment_ledger;"
   ```

Last restore drill: 2026-10-03, a dump of a disposable Postgres 17 restored into a scratch database with the built image (good dump restored; truncated archive and a dump with a failing statement both refused with a non-zero exit). A drill against a real production dump is still owed; record its date here when done.

## Healthcheck

The container is healthy when `/backups/heartbeat` exists and is newer than `BACKUP_HEARTBEAT_MAX_AGE`. The heartbeat is only written after the local dump and the optional S3 upload both succeed, so a failing healthcheck means backups are not completing. The heartbeat lives on the same volume as the backups so it survives container restarts.

## Image packages

The base image (`alpine:3.21.3`) is pinned, but the `apk` packages in `backup/Dockerfile` are deliberately not pinned to exact revisions: Alpine removes superseded revisions from its index, so exact pins stop resolving on their own schedule and break the image build (and with it the production deploy). Packages float within the Alpine 3.21 branch and `postgresql17-client` stays on Postgres major 17. To pick up newer package revisions, rebuild with `make backup-build`.
