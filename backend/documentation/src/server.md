# src/server.ts

## Purpose
Coordinates Fastify server startup: builds the app via `buildServer`, runs pending Drizzle migrations, verifies the schema, and starts listening on the configured port.

## Dependencies
- `PORT` (optional) — overrides the default `4242` listen port.
- `DATABASE_URL` — required by the migration runner and DB client.
- Indirect: relies on environment validation in `src/lib/env.ts` executed by `buildServer()`.

## Key Functions
- `start()` — instantiates the Fastify server, executes migrations with `runMigrations`, verifies schema compatibility through `verifyDatabaseSchema`, then calls `server.listen` with `host: '0.0.0.0'`.

## Example Usage
```bash
# Run the development server with automatic migration + schema verification
npm run dev

# Or execute the compiled server directly
node dist/server.js
```

Expect log output similar to:
```
{"env": {"STRIPE_SECRET_KEY": "sk_test******"}, "msg": "Environment configuration loaded (masked)."}
{"msg":"Database migrations executed (noop if already up to date)."}
{"msg":"Server listening at http://0.0.0.0:4242"}
```

## Testing & Debugging Notes
- Use `npm test` to run Vitest suites that spin up the Fastify instance and exercise critical routes.
- If startup fails with missing env vars, copy `env.example` to `.env` and re-run `npm run dev`.
- To inspect migration or schema errors, run `npm run db:migrate` manually before restarting the server.
