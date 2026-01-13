# drizzle/ (migrations)

## Purpose
Tracks database schema evolution for the Stripe Payment Portal using Drizzle ORM migration files. Startup automatically applies pending migrations before the server begins listening.

## Dependencies
- `DATABASE_URL` — required by the Drizzle migrator and CLI.
- Migration files live under `drizzle/` with metadata in `drizzle/meta/_journal.json`.
- `src/lib/migrate.ts` runs migrations at runtime via `drizzle-orm/node-postgres/migrator`.

## Common Commands
```bash
# Generate a new migration after editing src/db/schema.ts
npm run db:generate

# Apply migrations locally or in CI
npm run db:migrate

# Using Docker Compose (Makefile helper)
make migrate
```

## Example Workflow
1. Update `src/db/schema.ts` with new tables or columns.
2. Run `npm run db:generate` to create a SQL file under `drizzle/`.
3. Inspect and commit the generated SQL.
4. Execute `npm run db:migrate` (or `make migrate`) to apply changes.
5. Restart the API so startup verification (`verifyDatabaseSchema`) confirms the new state.

## Testing & Debugging Notes
- If migrations fail during startup, run `npm run db:migrate` manually to surface detailed errors.
- For production, run migrations in a separate job before deploying application containers.
- Keep backups of `drizzle/meta/_journal.json`; deleting it will cause Drizzle to re-run migrations from scratch.
