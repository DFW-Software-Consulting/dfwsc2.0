# Database and migrations

Authoritative detail: [docs/DATABASE.md](../DATABASE.md). PostgreSQL 17 with Drizzle ORM.

## Layout
- Two schema files feed one migration history: `backend/src/db/schema.ts` (`public` schema) and `backend/src/cerebo/schema.ts` (`cerebo` schema). `backend/drizzle.config.ts` lists both.
- Migrations: `backend/drizzle/NNNN_*.sql` with snapshots in `backend/drizzle/meta/`. Numbering is not gap-free: there is no `0021`, and `0019` exists twice (`0019_brave_ravenous` and `0019_hash_onboarding_tokens`, the latter hand-written). Check the journal before assuming order.
- Table groups: payments and Connect (`clients`, `client_groups`, `onboarding_tokens`, `payment_ledger`, `connect_*`), webhook dedupe (`webhook_events`), billing and Nextcloud automation state (`billing_*`, `sales_lead_*`, `client_onboarding_*`, `portal_mirror_*`, and similar), `admins`, Cerebo tables.

## Workflow
1. Edit the schema file.
2. `npm run db:generate` (root) to create the migration; commit SQL and snapshot together. The pre-commit hook blocks a schema change without a staged migration (`SKIP_MIGRATION_CHECK=1` overrides).
3. Development applies migrations automatically at API start (`backend/src/index.ts`, `lib/migrate.ts`). Production never does: a one-shot `migrator` service in `docker-compose.prod.yml` runs `npm run db:migrate` before the API starts.
4. At boot `verifyDatabaseSchema()` (`backend/src/lib/schema-check.ts`) checks required tables and columns. When you add a column the app depends on, add it to `REQUIRED_TABLES` there.

## Conventions and gotchas
- Credentials and tokens are stored as hashes (SHA-256 lookup, bcrypt verify for API keys; onboarding tokens SHA-256), never plaintext.
- Hand-edited migrations are acceptable where Drizzle cannot express the change. Example: `0042_daily_ironclad` adds fee CHECK constraints as `NOT VALID` so a bad legacy row cannot fail the deploy migrator; the snapshot is unaffected so `generate` still reports no change. A follow-up migration (`generate --custom`) should `VALIDATE CONSTRAINT` once a read-only query shows no offending rows (query in DATABASE.md).
- Fee rules live in `addFeeIssues` in `backend/src/lib/admin-crud.ts`; the CHECKs mirror it. Change both together.
- Feature-flagged integrations create their state tables in the normal migration run even when the flag is off.
- `.env.test` and `backend/.env` can change test DB behavior; see [dev-workflow.md](dev-workflow.md).
