# DFWSC Project Review — Full Codebase Audit

**Date**: 2026-03-13

---

## What This Project Is

**DFWSC Stripe Payment Portal** — a full-stack SaaS payment platform for DFW Software Consulting. Clients get onboarded via Stripe Connect, receive an API key, and can then create payments on your platform. You take a fee via Stripe's `application_fee_amount`. The admin dashboard lets you manage clients and toggle their status.

**Stack**: Fastify + Drizzle + Postgres (backend), React + Vite + nginx (frontend), Docker Compose for dev/prod.

---

## Issues Found

### Critical

- [x] **1. Broken API URLs in production — `FRONTEND_ORIGIN` multi-origin bug**
`connect.ts:173`, `payments.ts:129`

`FRONTEND_ORIGIN` can be comma-separated (e.g., `http://localhost:5174,http://localhost:4242`). `app.ts` correctly splits it for CORS. But everywhere else it's used raw:

```ts
const frontendOrigin = process.env.FRONTEND_ORIGIN?.replace(/\/$/, '');
// becomes: "http://localhost:5174,http://localhost:4242"
const onboardingUrlHint = `${frontendOrigin}/onboard?token=${token}`;
// result: "http://localhost:5174,http://localhost:4242/onboard?token=..."  ← broken URL
```

Affects: onboarding URLs, email links, Stripe checkout `success_url`/`cancel_url`, and all redirects. Need to take the first origin, or add a separate `FRONTEND_URL` env var.

---

- [x] **2. Missing nginx proxy — frontend can't reach the API**
`front/nginx.conf`

The nginx config only serves static files. With `VITE_API_URL=/api/v1` baked in at build time, the React app makes relative calls to `/api/v1/...` — which hits the same nginx container (port 8080), returning 404. There's no `location /api/v1 { proxy_pass http://api:4242; }` block.

```nginx
# Missing:
location /api/v1/ {
    proxy_pass http://api:4242;
}
```

This means the dockerized frontend is completely broken for API calls unless the user is running the Vite dev server directly.

---

### High

- [x] **3. `requireRole` is a security trap**
`auth.ts:10-19`

This exported function trusts the `x-api-role` request header — a client-controlled value:

```ts
export function requireRole(allowedRoles: Role[]) {
  return async function roleGuard(request, reply) {
    const roleHeader = request.headers['x-api-role']; // any client can set this!
    ...
  };
}
```

Any caller can add `x-api-role: admin` to bypass it. It's not currently used (routes use `requireAdminJwt` correctly), but it's exported and available. Should be deleted.

---

- [x] **4. `/onboard-client` and `/connect/refresh` have no rate limiting**
`connect.ts:241`, `connect.ts:273`

Both endpoints call `createAccountLinkForToken` which creates Stripe API calls and hits the DB. There's no `rateLimit` preHandler on either. The POST endpoints are rate limited, but these GETs aren't.

---

### Medium

- [x] **5. O(n) bcrypt scan on every API request**
`auth.ts:31-43`

```ts
const allClientsResult = await db.select().from(clients); // ALL clients
for (const client of allClients) {
  const isValid = await verifyPassword(apiKey, client.apiKeyHash); // bcrypt per client
```

Bcrypt is designed to be slow (~100ms). With 10 clients, every API request takes up to 1 second just for auth. With 50 clients, ~5 seconds. Consider SHA-256 pre-hashing for DB lookup, then bcrypt verifying only the matched record.

---

- [x] **6. Rate limiter memory leak**
`rate-limit.ts`

The `hitBuckets` Map is never pruned. Keys are never removed — only their timestamps are filtered per-request. Grows unboundedly over time.

Additionally, this is in-memory — resets on container restart and doesn't work with multiple API instances.

---

- [x] **7. `connect/callback` redirects to success when client is not found**
`connect.ts:369-379`

```ts
if (!clientRecord) {
  return reply.redirect(redirectUrl); // redirects to /onboarding-success — wrong!
}
```

A missing client should be an error (400/404), not a success redirect. This would silently succeed without linking the Stripe account.

---

- [x] **8. No DB transactions for multi-step operations**
`connect.ts:394-408`, `webhooks.ts:30-82`

In `connect/callback`, two separate DB writes happen without a transaction:
1. Update `clients.stripeAccountId`
2. Update `onboardingTokens.status = 'completed'`

If the server crashes between them, the client has a Stripe account linked but the token stays `in_progress`, causing retry issues.

---

- [x] **9. Plaintext API key still stored in DB schema**
`db/schema.ts`

The `clients` table has an `apiKey` column (plaintext). The current insert only writes `apiKeyHash`, but the column and plaintext lookup path in `auth.ts:46-55` remain. Legacy clients with plaintext keys in the DB are at risk if the DB is compromised.

---

### Low

- [x] **10. `stripe-cli` Docker variable substitution likely broken**
`docker-compose.yml:52`

```yaml
stripe-cli:
  env_file:
    - backend/.env
  environment:
    STRIPE_API_KEY: ${STRIPE_SECRET_KEY}  # Compose variable substitution
```

Docker Compose `${VAR}` substitution reads from the host env or root `.env` — NOT from `env_file`. If `STRIPE_SECRET_KEY` isn't in the root `.env` or host shell, this will be empty.

---

- [x] **11. PostgreSQL port 5432 exposed on all interfaces**
`docker-compose.yml:38`

```yaml
ports:
  - "5432:5432"  # accessible from any network interface
```

Should be `127.0.0.1:5432:5432` to prevent exposure in cloud/production deployments.

---

- [x] **12. `setupUsed` flag is session-scoped, not durable**
`auth.ts:44`

`setupUsed = true` resets on every container restart. The one-time admin setup endpoint can be called again after a restart if `ALLOW_ADMIN_SETUP` is still `true`. Mitigated by the `adminConfigured` check, but only if `ADMIN_PASSWORD` is already in env.

---

## Summary Table

| # | Status | Severity | Area | Issue |
|---|--------|----------|------|-------|
| 1 | [x] | Critical | Backend/Config | `FRONTEND_ORIGIN` multi-value breaks all redirect URLs |
| 2 | [x] | Critical | Frontend/Docker | nginx has no API proxy — all API calls 404 |
| 3 | [x] | High | Security | `requireRole` trusts client-controlled header |
| 4 | [x] | High | Security | `/onboard-client` and `/connect/refresh` have no rate limiting |
| 5 | [x] | Medium | Performance | O(n) bcrypt scan per API request |
| 6 | [x] | Medium | Backend | Rate limiter memory leak |
| 7 | [x] | Medium | Logic | Callback redirects to success on missing client |
| 8 | [x] | Medium | Data integrity | No transactions for multi-step DB writes |
| 9 | [x] | Medium | Security | Plaintext API key column still in schema |
| 10 | [x] | Low | Docker | stripe-cli variable substitution likely empty |
| 11 | [x] | Low | Security | Postgres exposed on all interfaces |
| 12 | [x] | Low | Logic | Admin setup flag non-durable across restarts |
