# API Reference

This reference aggregates the Fastify routes exposed by the Stripe Payment Portal. Each section links back to the deeper module documentation under `documentation/src/routes/`.

## Authentication & Headers

### API Role Header (Legacy)
- `x-api-role`: required for some protected routes. Accepts `admin` or `client` depending on endpoint.
- Note: Being phased out in favor of JWT Bearer token authentication for admin endpoints.

### JWT Bearer Token (Admin Authentication)
- `Authorization`: Required for admin-protected routes. Format: `Bearer <jwt_token>`
- Obtain token via `POST /api/v1/auth/login` endpoint
- Token expires based on `JWT_EXPIRY` environment variable (default: 1h)
- Include header in all admin-only endpoints (client list, client status management)

### Other Headers
- `Idempotency-Key`: recommended/required on all POST routes that mutate Stripe state.

## Endpoints

### Admin Authentication (`src/routes/auth.ts`)

#### POST `/api/v1/auth/login`
Authenticates an admin user and returns a JWT token for accessing protected endpoints.

**Authentication**: None (public endpoint)

**Rate Limiting**: 5 requests per 15 minutes per IP address

**Request Body**:
```json
{
  "username": "admin",
  "password": "your_password"
}
```

**Success Response** (200 OK):
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "1h"
}
```

**Error Responses**:
- `400 Bad Request`: Missing username or password
  ```json
  { "error": "Username and password are required" }
  ```
- `401 Unauthorized`: Invalid credentials
  ```json
  { "error": "Invalid credentials" }
  ```
- `429 Too Many Requests`: Rate limit exceeded (5 attempts per 15 minutes)
  ```json
  { "error": "Rate limit exceeded" }
  ```
- `500 Internal Server Error`: Server configuration error or JWT generation failure
  ```json
  { "error": "Server configuration error" }
  ```

**Notes**:
- Password can be plain text (development) or bcrypt hash (production)
- Failed login attempts are logged with username for security monitoring
- Token must be included in `Authorization: Bearer <token>` header for subsequent admin requests

---

### Client Management (`src/routes/clients.ts`)

#### GET `/api/v1/clients`
Retrieves a list of all clients in the system.

**Authentication**: Required (JWT Bearer token)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**Query Parameters**: None

**Success Response** (200 OK):
```json
[
  {
    "id": "client_abc123",
    "name": "Acme Corporation",
    "email": "billing@acme.com",
    "stripeAccountId": "acct_1234567890",
    "status": "active",
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  {
    "id": "client_def456",
    "name": "Widget Inc",
    "email": "finance@widget.com",
    "stripeAccountId": "acct_0987654321",
    "status": "inactive",
    "createdAt": "2024-02-20T14:45:00.000Z"
  }
]
```

**Error Responses**:
- `401 Unauthorized`: Missing or invalid JWT token
  ```json
  { "error": "Unauthorized" }
  ```
- `500 Internal Server Error`: Database query failure
  ```json
  { "error": "Internal server error" }
  ```

---

#### PATCH `/api/v1/clients/:id`
Updates the status of a specific client (soft delete/activate).

**Authentication**: Required (JWT Bearer token)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**URL Parameters**:
- `id` (string, required): Client ID to update

**Request Body**:
```json
{
  "status": "active" | "inactive"
}
```

**Success Response** (200 OK):
```json
{
  "id": "client_abc123",
  "name": "Acme Corporation",
  "email": "billing@acme.com",
  "stripeAccountId": "acct_1234567890",
  "status": "inactive",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-03-10T16:20:00.000Z"
}
```

**Error Responses**:
- `400 Bad Request`: Invalid status value
  ```json
  { "error": "Invalid status value. Must be \"active\" or \"inactive\"." }
  ```
- `401 Unauthorized`: Missing or invalid JWT token
  ```json
  { "error": "Unauthorized" }
  ```
- `404 Not Found`: Client ID does not exist
  ```json
  { "error": "Client not found." }
  ```
- `500 Internal Server Error`: Database update failure
  ```json
  { "error": "Internal server error" }
  ```

**Notes**:
- Setting status to `inactive` soft-deletes the client (does not remove from database)
- `updatedAt` timestamp is automatically set to current time on status change
- Client remains visible in client list regardless of status

---

### Connect Onboarding (`src/routes/connect.ts`)
- `POST /connect/onboard`
  - Body: `{ clientId, name, email }`.
  - Headers: `x-api-role: admin`, `Idempotency-Key`.
  - Response: `{ clientId, stripeAccountId, url }` (Stripe onboarding link).
- `GET /connect/callback`
  - Query: `client_id`, `account`.
  - Response: Redirect to `${FRONTEND_ORIGIN}/connect/success` when configured, otherwise JSON `{ clientId, stripeAccountId, status }`.

### Payments (`src/routes/payments.ts`)
- `POST /payments/create`
  - PaymentIntent mode: `{ clientId, amount, currency, description?, metadata?, applicationFeeAmount? }`.
  - Checkout mode: `{ clientId, lineItems, description?, metadata?, applicationFeeAmount?, amount? }`.
  - Headers: `x-api-role: admin|client`, `Idempotency-Key`.
  - Response: PaymentIntent `{ clientSecret, paymentIntentId }` or Checkout `{ url }`.

### Reports (`src/routes/payments.ts`)
- `GET /reports/payments`
  - Query: `clientId` (required), `limit?`, `starting_after?`, `ending_before?`.
  - Headers: `x-api-role: admin`.
  - Response: `{ clientId, data, hasMore }` with Stripe pagination metadata.

### Webhooks (`src/routes/webhooks.ts`)
- `POST /webhooks/stripe`
  - Headers: `Stripe-Signature` from Stripe.
  - Body: raw JSON webhook payload.
  - Response: `{ received: true }` after storing the event.

## Swagger UI
- Available at `/docs` when the server is running. Mirrors the same routes above for quick exploration.

## Testing Shortcuts
- Run `npm test` to execute Vitest suites that exercise all endpoints with mocked Stripe calls.
- Use `curl` examples in the route-specific docs and pair them with `stripe listen --forward-to localhost:4242/webhooks/stripe` for full flow validation.
