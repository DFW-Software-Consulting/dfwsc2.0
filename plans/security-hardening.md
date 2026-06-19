# Plan: Security Hardening

## Goal
Close all critical and high severity security gaps in the backend, frontend, and infrastructure layers of the DFWSC Payment Portal.

## Current State
- CORS allows all origins when `FRONTEND_ORIGIN` is empty (`app.ts:58-61`)
- `/auth/setup` returns bcrypt password hash in response body (`auth.ts:122-130`)
- Global error handler leaks internal error messages for 500s (`app.ts:75-87`)
- Connect callback trusts `account` query param without Stripe verification (`connect.ts:492-525`)
- JWT decoded token not attached to request (`auth.ts:90-126`)
- Nginx has zero security headers (`front/nginx.conf`)
- No TLS termination anywhere in the stack
- `confirm-bootstrap` lacks old-password verification (`auth.ts:139-183`)

---

## Step 1: Fix CORS fail-open behavior

**Files:** `backend/src/app.ts`

Change `origin: allowedOrigins.length === 0 ? true : allowedOrigins` to **reject** when no origins are configured. A payment portal must fail-closed.

```typescript
// BEFORE (line 59)
origin: allowedOrigins.length === 0 ? true : allowedOrigins,

// AFTER
origin: allowedOrigins.length > 0 ? allowedOrigins : false,
```

If `allowedOrigins` is empty, the server should either throw at startup (preferred) or reject all cross-origin requests. Add a startup check in `validateEnv()`:

```typescript
// In lib/env.ts — add to required vars check
if (!process.env.FRONTEND_ORIGIN || process.env.FRONTEND_ORIGIN.trim() === "") {
  throw new Error("FRONTEND_ORIGIN must be set to at least one allowed origin.");
}
```

**Verification:** Remove `FRONTEND_ORIGIN` from `.env` → server should refuse to start. With a value set → only that origin can make credentialed requests.

---

## Step 2: Stop leaking password hash in `/auth/setup` response

**File:** `backend/src/routes/auth.ts`

Remove `passwordHash` from the response body. The admin should only see the username — they already know the password they just typed.

```typescript
// BEFORE (lines 122-130)
return reply.code(200).send({
  username,
  passwordHash,        // ← REMOVE THIS
  instructions: [ ... ]
});

// AFTER
return reply.code(200).send({
  username,
  instructions: [
    "1. Use the username and the password you just entered to log in.",
    "2. Follow the confirm-bootstrap flow to finalize your setup.",
    "3. (Recommended) Set ALLOW_ADMIN_SETUP=false in your environment.",
  ],
});
```

**Verification:** `POST /auth/setup` response should contain `username` and `instructions` only — no `passwordHash` field.

---

## Step 3: Sanitize global error handler

**File:** `backend/src/app.ts`

For non-validation 500 errors, return a generic message. Log the full error server-side.

```typescript
// BEFORE (lines 75-87)
server.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode ?? (error.validation ? 400 : 500);
  if (error.validation) {
    reply.status(statusCode).send({ error: error.message, requestId: request.id });
    return;
  }
  request.log.error(error, error.message);
  reply.status(statusCode).send({ error: error.message ?? "Internal Server Error", requestId: request.id });
});

// AFTER
server.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode ?? (error.validation ? 400 : 500);

  if (error.validation) {
    reply.status(statusCode).send({ error: error.message, requestId: request.id });
    return;
  }

  request.log.error(error, error.message);

  // Only expose the message for known operational errors (4xx with explicit statusCode)
  const safeMessage =
    statusCode < 500 && error.message
      ? error.message
      : "Internal Server Error";

  reply.status(statusCode).send({ error: safeMessage, requestId: request.id });
});
```

**Verification:** Trigger a DB connection error → response should be `{"error":"Internal Server Error"}` (not connection string). Trigger a validation error → response should still show the specific message.

---

## Step 4: Verify Connect callback account with Stripe

**File:** `backend/src/routes/connect.ts`

After the regex check on `normalizedAccount`, retrieve the account from Stripe to confirm it exists and is an Express account.

```typescript
// AFTER line 525 (after regex check), BEFORE the DB lookups:
// Verify the account actually exists in Stripe
try {
  const verifiedAccount = await stripe.accounts.retrieve(normalizedAccount);
  if (verifiedAccount.type !== "express") {
    request.log.warn({ account: normalizedAccount }, "Account is not an Express account");
    return reply.code(400).send({ error: "Invalid account type." });
  }
} catch (err) {
  request.log.warn({ account: normalizedAccount, err }, "Failed to verify account with Stripe");
  return reply.code(400).send({ error: "Invalid or nonexistent Stripe account." });
}
```

**Verification:** Pass `acct_fake123` as the account param → should return 400 (Stripe won't find it). Pass a real Express account → proceeds normally.

---

## Step 5: Add security headers to nginx

**File:** `front/nginx.conf`

Add these directives inside the `server {}` block:

```nginx
# Security headers
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';" always;

# HSTS (enable after confirming TLS works)
# add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
```

**Verification:** `curl -I http://localhost:80/` → response should include all headers. `X-Frame-Options: DENY` prevents embedding in iframes. `nosniff` prevents MIME type sniffing.

---

## Step 6: Attach decoded JWT to request

**File:** `backend/src/lib/auth.ts`

In `requireAdminJwt`, attach the decoded payload so routes can identify the admin.

```typescript
// BEFORE (lines 106-125)
try {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload & { role: string };
  if (decoded.role !== "admin") {
    return reply.code(403).send({ error: "Forbidden: Admin role required" });
  }
} catch (error) { ... }

// AFTER
try {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload & { role: string };
  if (decoded.role !== "admin") {
    return reply.code(403).send({ error: "Forbidden: Admin role required" });
  }
  // Attach admin info to request for downstream use
  (request as any).admin = decoded;
} catch (error) { ... }
```

**Verification:** Access any admin endpoint → `request.admin` should contain `{ role: "admin", iat, exp }`.

---

## Step 7: Add TLS termination (nginx or Caddy)

**Files:** `docker-compose.prod.yml`, new `docker-compose.https.yml` or Caddy config

**Option A — Caddy (recommended, simplest):**
Add a Caddy service in production that handles TLS via Let's Encrypt:

```yaml
# In docker-compose.prod.yml, add:
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on:
      - web
    restart: unless-stopped

  # Bind API to localhost only
  api:
    # ... existing config ...
    ports:
      - "127.0.0.1:4242:4242"  # ← Change from 0.0.0.0
```

```
# Caddyfile
yourdomain.com {
    reverse_proxy web:80
    encode gzip
}

api.yourdomain.com {
    reverse_proxy api:4242
}
```

**Option B — nginx with certbot:**
Update `front/Dockerfile` and `docker-compose.prod.yml` for SSL. More complex but uses the existing nginx stack.

**Verification:** `curl -I https://yourdomain.com` → should return 200 with `Strict-Transport-Security` header. HTTP should redirect to HTTPS.

---

## Step 8: Remove legacy API key full-scan fallback

**File:** `backend/src/lib/auth.ts`

The legacy fallback (lines 42-52) loads ALL clients with null `apiKeyLookup` and runs bcrypt sequentially. This is both a security risk (timing attack, DoS) and a performance bomb.

Add a migration to populate `apiKeyLookup` for all legacy clients, then remove the fallback:

```typescript
// Create a one-time migration script: scripts/migrate-legacy-keys.ts
// For each client with apiKeyLookup IS NULL but apiKeyHash IS NOT NULL,
// generate a new API key, populate apiKeyLookup with its SHA-256 hash,
// and output the key for the admin.

// Then REMOVE lines 42-52 from auth.ts:
// DELETE: const legacyClients = await db.select()...
// DELETE: for (const client of legacyClients) { ... }
```

**Verification:** All existing clients have `apiKeyLookup` populated. Auth only uses the fast SHA-256 path.

---

## Step 9: Add JWT_SECRET strength validation

**File:** `backend/src/lib/env.ts`

```typescript
// Add to validateEnv():
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("JWT_SECRET is required");
}
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}
```

**Verification:** Set `JWT_SECRET=short` → server refuses to start.

---

## Verification Plan
1. Remove `FRONTEND_ORIGIN` → server refuses to start
2. `POST /auth/setup` → response has no `passwordHash` field
3. Trigger 500 error → response is `{"error":"Internal Server Error"}` (no internals)
4. `curl -I http://localhost/` → all security headers present
5. Pass fake `acct_` to `/connect/callback` → 400 (Stripe rejects it)
6. Set weak `JWT_SECRET` → server refuses to start
7. `curl -Ik https://yourdomain.com` → TLS works, HSTS header present

## Risks
- TLS setup requires DNS and domain configuration — may need staging environment
- Removing legacy API key fallback requires migration script for existing clients
- Stricter error handling may surface 400s where 500s were previously shown
- CSP header may need tuning if any inline scripts/styles are added later
