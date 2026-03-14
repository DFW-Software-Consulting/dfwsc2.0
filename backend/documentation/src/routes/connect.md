# src/routes/connect.ts

## Purpose
Handles Stripe Connect onboarding flow for clients, including account creation, onboarding token management, and OAuth callback handling.

## Dependencies
- Stripe SDK for account and account link creation
- Drizzle ORM for database operations
- `src/lib/auth.ts` - `requireAdminJwt`, `hashApiKey`, `sha256Lookup`
- `src/lib/rate-limit.ts` - Rate limiting
- `src/lib/mailer.ts` - Email delivery for onboarding invitations
- `uuid` - Client ID generation
- `crypto` - Secure token and API key generation
- `validator` - Email validation
- `he` - HTML encoding for emails

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_SECRET_KEY` | ✅ | Stripe API key for Connect operations |
| `FRONTEND_ORIGIN` | ✅ | Base URL for onboarding redirect (supports comma-separated list, uses first value) |
| `API_BASE_URL` | ❌ | Public API URL (auto-detected from request headers if not set) |
| `SMTP_HOST` | ✅ | SMTP server for sending onboarding emails |
| `SMTP_PORT` | ✅ | SMTP port (587 for STARTTLS, 465 for SMTPS) |
| `SMTP_USER` | ✅ | SMTP username |
| `SMTP_PASS` | ✅ | SMTP password/app password |
| `SMTP_FROM` | ❌ | From address (defaults to `SMTP_USER`) |

## Routes

### POST `/api/v1/accounts`
Creates a new client record with onboarding token and returns API key (shown once only).

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Rate Limiting**: 10 requests per minute per IP

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**Request Body**:
```json
{
  "name": "Acme Corporation",
  "email": "billing@acme.com"
}
```

**Success Response** (201 Created):
```json
{
  "name": "Acme Corporation",
  "onboardingToken": "abc123...",
  "onboardingUrlHint": "http://localhost:8080/onboard?token=abc123...",
  "apiKey": "sk_live_abc123...",
  "clientId": "client_abc123"
}
```

**Error Responses**:
- `400 Bad Request`: Missing or invalid name/email
- `401 Unauthorized**: Missing or invalid JWT token
- `429 Too Many Requests**: Rate limit exceeded
- `500 Internal Server Error**: FRONTEND_ORIGIN not configured or database failure

**Security Notes**:
- `apiKey` is returned only once and never stored in plaintext
- API key is hashed with bcrypt (`apiKeyHash`) and SHA-256 (`apiKeyLookup`) before storage
- Token is secure random bytes (32 bytes, hex-encoded)

---

### POST `/api/v1/onboard-client/initiate`
Creates client record and sends onboarding email with token link.

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Rate Limiting**: 10 requests per minute per IP

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**Request Body**:
```json
{
  "name": "Acme Corporation",
  "email": "billing@acme.com"
}
```

**Success Response** (201 Created):
```json
{
  "message": "Onboarding email sent successfully.",
  "clientId": "client_abc123",
  "apiKey": "sk_live_abc123..."
}
```

**Error Responses**:
- `400 Bad Request`: Missing or invalid name/email
- `401 Unauthorized**: Missing or invalid JWT token
- `429 Too Many Requests**: Rate limit exceeded
- `500 Internal Server Error**: Email delivery failure or database error

**Email Template**:
- HTML and text versions sent
- Includes onboarding link: `{FRONTEND_ORIGIN}/onboard?token={token}`
- Name and email are HTML-encoded to prevent XSS

---

### GET `/api/v1/onboard-client`
Exchanges a valid onboarding token for a Stripe account link URL.

**Authentication**: None (public endpoint, token-based)

**Rate Limiting**: 10 requests per minute per IP

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | string | Onboarding token from invitation |

**Success Response** (200 OK):
```json
{
  "url": "https://connect.stripe.com/express/onboarding/..."
}
```

**Error Responses**:
- `404 Not Found**: Invalid, expired, or already-used token
- `429 Too Many Requests**: Rate limit exceeded
- `502 Bad Gateway**: Stripe API failure (token remains valid for retry)

**Flow Notes**:
- Token status transitions: `pending` → `in_progress` (when link created)
- Creates Stripe Express account if client doesn't have one yet
- Generates CSRF `state` parameter with 30-minute expiration

---

### GET `/api/v1/connect/refresh`
Regenerates an account link for incomplete onboarding sessions.

**Authentication**: None (public endpoint, token-based)

**Rate Limiting**: 10 requests per minute per IP

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | string | Onboarding token |

**Success Response**: Redirect to Stripe account link URL

**Error Responses**:
- `404 Not Found**: Invalid or expired token
- `429 Too Many Requests**: Rate limit exceeded
- `502 Bad Gateway**: Stripe API failure

**Use Case**: Client started onboarding but didn't complete; link expired and needs regeneration.

---

### GET `/api/v1/connect/callback`
Stripe OAuth callback endpoint. Links Stripe account to client record.

**Authentication**: None (public endpoint, state-based CSRF protection)

**Query Parameters** (from Stripe redirect):
| Parameter | Type | Description |
|-----------|------|-------------|
| `client_id` | string | Client ID (passed in initial `return_url`) |
| `account` | string | Stripe account ID (e.g., `acct_...`) |
| `state` | string | CSRF state parameter |

**Success Response**: Redirect to `{FRONTEND_ORIGIN}/onboarding-success`

**Error Responses**:
- `400 Bad Request`: Missing `state`, `account`, or `client_id` parameter
- `400 Bad Request**: Invalid `account` format (must match `^acct_[A-Za-z0-9]+$`)
- `400 Bad Request**: Invalid or expired state parameter
- `400 Bad Request**: State/account mismatch (CSRF attack prevention)
- `500 Internal Server Error**: FRONTEND_ORIGIN not configured

**Security Notes**:
- State parameter validated against stored value in `onboarding_tokens` table
- State expiration checked (30 minutes from creation)
- Prevents overwriting existing `stripeAccountId` (one-time link)
- Transactional update ensures atomicity of client + token status updates

**Flow Notes**:
- Token status transitions: `in_progress` → `completed`
- Client `stripeAccountId` is set atomically with token status update
- Existing Stripe account ID mismatch returns 400 (prevents account hijacking)

---

## Testing & Debugging Notes

### Create Client and Get Token
```bash
curl -X POST http://localhost:4242/api/v1/accounts \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Client","email":"test@example.com"}'
```

### Get Onboarding Link
```bash
curl "http://localhost:4242/api/v1/onboard-client?token=abc123..."
```

### Simulate Stripe Callback (Testing Only)
```bash
curl "http://localhost:4242/api/v1/connect/callback?client_id=client_abc123&account=acct_123&state=xyz789..."
```

### Common Issues

**"FRONTEND_ORIGIN is not configured"**
- Ensure `FRONTEND_ORIGIN` is set in environment
- For comma-separated list, only first value is used

**"Invalid or expired state parameter"**
- State expires 30 minutes after creation
- State must match exactly what was stored when link was created
- Fix: Use `/connect/refresh` to generate new link

**"Stripe account already linked to this client"**
- Client record already has `stripeAccountId` set
- This is a security feature to prevent account hijacking
- Fix: Contact support if this is unexpected

**"Onboarding token... has already been used"**
- Token status is `completed` or `expired`
- Fix: Admin must generate new token via `/accounts` or `/onboard-client/initiate`

**Email not delivered**
- Check SMTP configuration
- Verify `SMTP_FROM` is valid for your mail provider
- Check MailHog (dev) or email logs for delivery status
