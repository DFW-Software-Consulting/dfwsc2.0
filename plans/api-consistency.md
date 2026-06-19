# Plan: API Consistency & Quality

## Goal
Standardize error responses, add pagination to list endpoints, enforce input validation with Zod, eliminate DRY violations, and add missing REST endpoints.

## Current State
- Error response shapes vary across routes: `{ error }`, `{ error, code }`, `{ error, requestId }`, `{ error, setupRequired }`
- `GET /clients` and `GET /groups` return all records with no pagination
- `GET /reports/payments` hardcodes `hasMore: false` for group queries
- `isValidHttpsUrl` duplicated in `clients.ts` and `groups.ts`
- `frontendOrigin` extraction repeated 4 times in `connect.ts`
- Email HTML templates duplicated in `connect.ts`
- PATCH `/clients/:id` uses a 23-field manual type for Drizzle `set()`
- `PATCH /groups/:id` does a second query instead of using `.returning()`
- No DELETE endpoints for clients or groups
- No Zod validation on most request bodies (only Fastify JSON schema)

---

## Step 1: Create a unified error response helper

**File:** New `backend/src/lib/errors.ts`

```typescript
export interface ApiError {
  error: string;
  code?: string;
  requestId?: string;
}

export class AppError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Common error factories
export const errors = {
  notFound: (resource: string) => new AppError(`${resource} not found`, 404, "NOT_FOUND"),
  unauthorized: (msg = "Authentication required") => new AppError(msg, 401, "UNAUTHORIZED"),
  forbidden: (msg = "Insufficient permissions") => new AppError(msg, 403, "FORBIDDEN"),
  badRequest: (msg: string) => new AppError(msg, 400, "BAD_REQUEST"),
  conflict: (msg: string) => new AppError(msg, 409, "CONFLICT"),
  internal: (msg = "Internal server error") => new AppError(msg, 500, "INTERNAL_ERROR"),
  stripeFailed: (msg: string) => new AppError(msg, 502, "STRIPE_FAILED"),
};
```

Update the global error handler in `app.ts` to check for `AppError`:

```typescript
server.setErrorHandler((error, request, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
      requestId: request.id,
    });
  }
  // ... existing validation and 500 handling
});
```

**Verification:** All error responses follow `{ error, code, requestId }` shape.

---

## Step 2: Add pagination to `GET /clients`

**File:** `backend/src/routes/clients.ts`

Add `limit`, `offset`, and `search` query parameters:

```typescript
fastify.get("/clients", {
  preHandler: [rateLimit({ max: 20, windowMs: 60_000 }), requireAdminJwt],
  schema: {
    querystring: {
      type: "object",
      required: ["workspace"],
      properties: {
        workspace: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
        search: { type: "string" },
        groupId: { type: "string" },
      },
    },
  },
}, async (request, reply) => {
  const { workspace, limit = 50, offset = 0, search, groupId } = request.query as any;

  let query = db.select().from(clients).where(eq(clients.workspace, workspace));

  if (groupId) {
    query = query.where(and(eq(clients.workspace, workspace), eq(clients.groupId, groupId)));
  }

  if (search) {
    query = query.where(or(
      ilike(clients.name, `%${search}%`),
      ilike(clients.email, `%${search}%`),
    ));
  }

  const data = await query.limit(limit).offset(offset);

  // Get total count for pagination metadata
  const [{ count }] = await db
    .select({ count: count() })
    .from(clients)
    .where(eq(clients.workspace, workspace));

  return reply.send({
    data,
    pagination: {
      total: Number(count),
      limit,
      offset,
      hasMore: offset + limit < Number(count),
    },
  });
});
```

Apply the same pattern to `GET /groups`.

**Verification:** `GET /api/v1/clients?workspace=client_portal&limit=10&offset=0` → returns 10 clients with `{ data, pagination: { total, limit, offset, hasMore } }`.

---

## Step 3: Fix `PATCH /groups/:id` to use `.returning()`

**File:** `backend/src/routes/groups.ts`

```typescript
// BEFORE (lines 169-176)
await db.update(clientGroups).set(setValues).where(eq(clientGroups.id, id));
const [updated] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);

// AFTER
const [updated] = await db.update(clientGroups)
  .set(setValues)
  .where(eq(clientGroups.id, id))
  .returning();
```

**Verification:** `PATCH /groups/:id` returns the updated group in one query.

---

## Step 4: Extract DRY violations into shared utilities

### 4a: `isValidHttpsUrl` → `backend/src/lib/validation.ts`

```typescript
// backend/src/lib/validation.ts (already exists — add to it)
export function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}
```

Remove from `clients.ts:35-41` and `groups.ts:27-33`, import from `lib/validation.ts`.

### 4b: `resolveFrontendOrigin` → `backend/src/lib/config.ts`

```typescript
// backend/src/lib/config.ts
export function resolveFrontendOrigin(): string {
  const origin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
  if (!origin) {
    throw new AppError("FRONTEND_ORIGIN is not configured", 500, "CONFIGURATION_ERROR");
  }
  return origin;
}
```

Replace all 4 occurrences in `connect.ts` (lines 178, 255, 375, 613).

### 4c: Email templates → `backend/src/lib/mailer.ts`

```typescript
// backend/src/lib/mailer.ts
export function buildOnboardingEmail(opts: {
  companyName: string;
  clientName: string;
  onboardingUrl: string;
  isNew?: boolean;
}): { subject: string; html: string; text: string } {
  const { companyName, clientName, onboardingUrl, isNew } = opts;
  const safeName = he.encode(clientName);

  return {
    subject: isNew
      ? `${companyName} - Stripe Onboarding`
      : `${companyName} - New Onboarding Link`,
    html: `
      <h1>${isNew ? "Welcome to" : "Stripe Onboarding Link Refreshed —"} ${he.encode(companyName)}</h1>
      <p>Hi ${safeName},</p>
      <p>${isNew
        ? "Click the link below to start your Stripe onboarding process."
        : "Your previous onboarding link has expired or been invalidated. Click the new link below to continue."
      }</p>
      <a href="${onboardingUrl}">${isNew ? "Onboard Now" : "Continue Onboarding"}</a>
      <p>If you did not ${isNew ? "request this" : "request this, please contact us"}.</p>
      ${!isNew ? "<p><strong>Note:</strong> This link will expire in 30 minutes.</p>" : ""}
    `,
    text: `${isNew ? "Welcome to" : "Stripe Onboarding Link Refreshed —"} ${companyName}\nHi ${clientName},\n${isNew
      ? "Click the link below to start your Stripe onboarding process."
      : "Your previous onboarding link has expired.\nClick the new link below to continue."
    }\n${onboardingUrl}\nIf you did not request this, please ignore this email.`,
  };
}
```

**Verification:** All routes import from shared utilities. No duplicated function bodies.

---

## Step 5: Use `Partial<typeof clients.$inferInsert>` for PATCH

**File:** `backend/src/routes/clients.ts`

```typescript
// BEFORE (lines 263-305) — 23-field manual type
const setValues: Record<string, unknown> = {};
if (name !== undefined) setValues.name = name;
if (email !== undefined) setValues.email = email;
// ... 20 more fields

// AFTER
type ClientUpdate = Partial<typeof clients.$inferInsert>;
const setValues: ClientUpdate = {};
if (name !== undefined) setValues.name = name;
if (email !== undefined) setValues.email = email;
// ... same logic but type-safe
```

**Verification:** Adding a new column to `clients` schema automatically makes it available in `ClientUpdate`.

---

## Step 6: Add missing DELETE endpoints

**File:** `backend/src/routes/clients.ts`

```typescript
fastify.delete("/clients/:id", {
  preHandler: [rateLimit({ max: 10, windowMs: 60_000 }), requireAdminJwt],
}, async (request, reply) => {
  const { id } = request.params as { id: string };
  const [deleted] = await db.delete(clients)
    .where(eq(clients.id, id))
    .returning({ id: clients.id });

  if (!deleted) {
    return reply.code(404).send({ error: "Client not found" });
  }
  return reply.send({ message: "Client deleted", id: deleted.id });
});
```

Same for `DELETE /groups/:id` in `groups.ts`.

**Verification:** `DELETE /clients/:id` → 200 with `{ message, id }`. `DELETE /groups/:id` with `onDelete: "set null"` → clients' `groupId` becomes NULL.

---

## Step 7: Fix redundant workspace filter

**File:** `backend/src/routes/clients.ts`

```typescript
// BEFORE (lines 84-88)
const scopedList = clientList.filter((client) => client.workspace === workspace);

// AFTER — remove this line entirely
// The DB query already filters by workspace
```

**Verification:** Response is identical before and after.

---

## Verification Plan
1. All error responses follow `{ error, code, requestId }` shape
2. `GET /clients?limit=10&offset=0` → paginated response with `hasMore`
3. `PATCH /groups/:id` returns updated group in one query
4. No duplicated `isValidHttpsUrl`, `resolveFrontendOrigin`, or email templates
5. `DELETE /clients/:id` removes client, sets children's `groupId` to NULL
6. `PATCH /clients/:id` type is inferred from schema

## Risks
- Pagination changes the API response shape — frontend must handle `{ data, pagination }` wrapper
- Adding DELETE endpoints changes the API contract — ensure frontend is updated
- CHECK constraints must not break existing data — verify before applying
- Shared utilities must be tested independently
