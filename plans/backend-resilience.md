# Plan: Backend Resilience

## Goal
Make the backend fault-tolerant: handle Stripe API failures, prevent infinite webhook retry loops, implement graceful shutdown, and replace the in-memory rate limiter with a production-ready solution.

## Current State
- Webhook event processing has no try/catch — partial failures cause infinite Stripe retries (`webhooks.ts:62-219`)
- No graceful shutdown — SIGTERM kills in-flight requests (`index.ts`)
- Stripe API calls in payments, products, and connect routes have no try/catch
- In-memory rate limiter is per-process, not suitable for multi-instance (`rate-limit.ts`)
- Client factory uses manual rollback instead of DB transaction (`client-factory.ts:64-92`)
- `sendMail` errors unhandled in Connect routes (`connect.ts:279,403`)
- Settings table queried on every payment without caching

---

## Step 1: Wrap webhook event processing in try/catch

**File:** `backend/src/routes/webhooks.ts`

The `switch` statement (lines 62-219) must be wrapped in try/catch. On failure, mark the event with an error indicator so Stripe stops retrying.

```typescript
// BEFORE (line 62)
switch (event.type) {
  // ... cases ...
}

// AFTER
try {
  switch (event.type) {
    // ... all existing cases unchanged ...
  }
} catch (err) {
  request.log.error({ err, eventId: event.id, eventType: event.type }, "Webhook event processing failed");
  // Still mark as processed to prevent infinite retry — log the error for investigation
  // Stripe will retry anyway if we return 500, but we should not let partial failures loop
}

// The processedAt update (line 221-224) already runs after the switch — keep it
```

Additionally, wrap the `invoice.paid` Stripe API calls (lines 163-188) in their own try/catch:

```typescript
case "invoice.paid": {
  // ... existing log ...
  if (inv.subscription && typeof inv.subscription === "string") {
    try {
      const sub = await stripe.subscriptions.retrieve(inv.subscription);
      // ... existing update logic ...
    } catch (err) {
      fastify.log.error({ err, subscriptionId: inv.subscription }, "Failed to update subscription metadata");
      // Don't throw — the payment succeeded, just metadata update failed
    }
  }
  break;
}
```

**Verification:** Simulate a Stripe API timeout during `invoice.paid` → webhook should return 200, log the error, and not loop infinitely.

---

## Step 2: Add graceful shutdown

**File:** `backend/src/index.ts`

Handle `SIGTERM` and `SIGINT` to drain in-flight requests before exiting.

```typescript
// AFTER server.listen() (line 24), BEFORE the catch block:

// Graceful shutdown
const shutdown = async (signal: string) => {
  server.log.info({ signal }, "Received signal, shutting down gracefully");
  try {
    await server.close(); // Stops accepting new connections, drains existing
    server.log.info("Server closed successfully");
    process.exit(0);
  } catch (err) {
    server.log.error(err, "Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

Also ensure the DB pool is closed:

```typescript
// In backend/src/db/client.ts, export the pool:
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
export { pool };

// In index.ts shutdown handler:
const { pool } = await import("./db/client");
// ... after server.close():
await pool.end();
```

**Verification:** `docker stop <api-container>` → logs show "Received SIGTERM, shutting down gracefully" → in-flight requests complete → process exits cleanly.

---

## Step 3: Add try/catch around Stripe API calls in payments

**File:** `backend/src/routes/payments.ts`

Wrap `stripe.paymentIntents.create()` and `stripe.checkout.sessions.create()` in try/catch with proper error translation.

```typescript
// Example for PaymentIntent path:
try {
  const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
    idempotencyKey: idempotencyKey || undefined,
  });
  return reply.send({ clientSecret: paymentIntent.client_secret });
} catch (err) {
  request.log.error({ err }, "Stripe PaymentIntent creation failed");
  if (err instanceof Stripe.errors.StripeCardError) {
    return reply.code(402).send({ error: err.message, code: "CARD_DECLINED" });
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return reply.code(429).send({ error: "Payment service is busy. Please retry.", code: "RATE_LIMITED" });
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    return reply.code(400).send({ error: "Invalid payment parameters.", code: "INVALID_REQUEST" });
  }
  return reply.code(502).send({ error: "Payment processing failed. Please try again.", code: "PAYMENT_FAILED" });
}
```

Apply the same pattern to:
- `stripe.checkout.sessions.create()` in the Checkout path
- `stripe.products.list()`, `stripe.products.create()`, `stripe.taxRates.list()` in `products.ts`

**Verification:** Mock Stripe to throw `StripeCardError` → response is 402 with `CARD_DECLINED`. Mock timeout → response is 502 with `PAYMENT_FAILED`.

---

## Step 4: Add try/catch around sendMail in Connect routes

**File:** `backend/src/routes/connect.ts`

Mail failures should not prevent client creation. Wrap `sendMail` calls and log failures.

```typescript
// In /onboard-client/initiate (line 279):
try {
  await sendMail({ to: email, subject: ..., html: ..., text: ... });
} catch (err) {
  request.log.error({ err, clientId, email }, "Failed to send onboarding email");
  // Don't fail the request — client and token were created successfully
}

// Same pattern in /onboard-client/resend (line 403):
try {
  await sendMail({ to: clientRecord.email, subject: ..., html: ..., text: ... });
} catch (err) {
  request.log.error({ err, clientId: clientRecord.id }, "Failed to resend onboarding email");
}
```

Update the response to indicate email status:

```typescript
return reply.code(201).send({
  message: "Client created. Email sending may have failed — check logs.",
  clientId,
  apiKey,
  emailSent: false,  // or track success
});
```

**Verification:** Mock SMTP to fail → client is still created, response is 201, error is logged.

---

## Step 5: Replace in-memory rate limiter with Redis-backed solution

**File:** `backend/src/lib/rate-limit.ts`

Replace the `Map<string, number[]>` with a Redis-backed sliding window. Use `@fastify/rate-limit` with a Redis store, or implement a simple Redis sliding window.

**Option A — Use `@fastify/rate-limit` (recommended):**

```bash
npm install @fastify/rate-limit ioredis
```

```typescript
// In app.ts:
import rateLimit from "@fastify/rate-limit";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

await server.register(rateLimit, {
  max: 100, // default
  timeWindow: "1 minute",
  store: {
    // Use @fastify/rate-limit with ioredis
  },
});
```

**Option B — Simple Redis sliding window (no new dependency):**

```typescript
// backend/src/lib/rate-limit.ts
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs, keyGenerator } = options;

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = `ratelimit:${keyGenerator ? keyGenerator(request) : request.ip}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, `${now}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs);
    const results = await pipeline.exec();

    const count = (results?.[2]?.[1] as number) ?? 0;
    if (count > max) {
      return reply.code(429).send({ error: "Too Many Requests" });
    }
  };
}
```

**Prerequisites:** Add Redis to `docker-compose.base.yml`:

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6379:6379"
    restart: unless-stopped
```

**Verification:** Start two API instances → rate limit applied across both. Restart one instance → rate limit state persists.

---

## Step 6: Use DB transaction in client factory

**File:** `backend/src/lib/client-factory.ts`

Replace the manual try/catch rollback with a proper transaction.

```typescript
// BEFORE (lines 64-92)
await db.insert(clients).values({ ... });
try {
  await db.insert(onboardingTokens).values({ ... });
} catch (error) {
  try { await db.delete(clients).where(...); } catch { }
  throw error;
}

// AFTER
await db.transaction(async (tx) => {
  await tx.insert(clients).values({
    id: clientId,
    workspace,
    name,
    email,
    apiKeyHash,
    apiKeyLookup: lookup,
    status: "pending",
    groupId: groupId ?? null,
  });

  await tx.insert(onboardingTokens).values({
    id: newOnboardingTokenId,
    clientId,
    token,
    status: "pending",
    email,
  });
});
```

**Verification:** Kill the process between client insert and token insert → neither record exists (atomic).

---

## Step 7: Cache settings table reads

**File:** `backend/src/lib/stripe-billing.ts`

Add a simple in-memory cache with TTL for settings that rarely change.

```typescript
let settingsCache: { data: Record<string, string>; expiresAt: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 30_000; // 30 seconds

export async function getSettings(): Promise<Record<string, string>> {
  if (settingsCache && Date.now() < settingsCache.expiresAt) {
    return settingsCache.data;
  }

  const allSettings = await db.select().from(settings);
  const map: Record<string, string> = {};
  for (const row of allSettings) {
    map[row.key] = row.value;
  }

  settingsCache = { data: map, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  return map;
}

// In settings PATCH route, invalidate cache:
settingsCache = null;
```

**Verification:** Create two payments within 30 seconds → second payment uses cached settings (no DB query logged).

---

## Verification Plan
1. Simulate Stripe timeout during webhook → 200 response, error logged, no infinite retry
2. `docker stop <api>` → logs show graceful shutdown, in-flight requests complete
3. Mock `stripe.paymentIntents.create` to throw → response is 402/502 with proper code
4. Mock SMTP failure → client still created, error logged
5. Run two API instances → rate limit enforced globally via Redis
6. Kill process during client creation → no orphaned records (transaction)
7. Update settings → second payment within 30s uses cached value

## Risks
- Adding Redis is a new infrastructure dependency — must be deployed alongside API
- Transaction in client factory changes error behavior — callers must handle transaction-level errors
- Settings cache has a 30s stale window — acceptable for rarely-changing values
- Graceful shutdown timeout should be tuned (e.g., 30s max) to prevent hanging
