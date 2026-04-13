# Action Items for Next Developer

## 🔴 Critical (Fix First)

### 1. Fix Authentication Documentation
**Files to update:** `API_DOCS.md`, `README.md`

**Problem:** Docs describe env var auth (`ADMIN_USERNAME`, `ADMIN_PASSWORD`), but code uses DB-backed admins.

**Changes needed:**
- [ ] Remove `ADMIN_USERNAME` and `ADMIN_PASSWORD` from README.md env vars section
- [ ] Document `ALLOW_ADMIN_SETUP` and `ADMIN_SETUP_TOKEN` env vars
- [ ] Update `/auth/setup` endpoint description in API_DOCS.md
- [ ] Add `/auth/confirm-bootstrap` endpoint documentation
- [ ] Document the setup flag file (`SETUP_FLAG_PATH`)

### 2. Document Missing API Routes
**Files to update:** `API_DOCS.md`

Add documentation for:
- [ ] `GET /api/v1/config` - Returns `{ useCheckout: boolean }`
- [ ] `GET /api/v1/products` - List Stripe products
- [ ] `POST /api/v1/products` - Create Stripe product
- [ ] `GET /api/v1/stripe-customers` - List Stripe customers
- [ ] `POST /api/v1/stripe-customers` - Create Stripe customer
- [ ] `GET /api/v1/dfwsc-clients` - List DFWSC workspace clients
- [ ] `GET /api/v1/settings` - Get system settings

## 🟡 Medium Priority

### 3. Expand Database Documentation
**Files to update:** `DATABASE.md`

- [ ] Document all `clients` table fields:
  - `phone`, `billingContactName`
  - `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`
  - `notes`, `defaultPaymentTermsDays`
- [ ] Document the `settings` table
- [ ] Add field descriptions and example values

### 4. Update Frontend Documentation
**Files to update:** `FRONTEND.md`

- [ ] Document the `/docs` route
- [ ] List all admin dashboard features
- [ ] Document the workspace concept in frontend

## 🟢 Low Priority

### 5. Code Organization Improvements

- [ ] Consider removing duplicate agent files (AGENTS.md = CLAUDE.md = Gemini.md = Qwen.md)
- [ ] Add JSDoc comments to route handlers
- [ ] Add inline comments explaining workspace separation

### 6. Additional Documentation

- [ ] Create a CHANGELOG.md
- [ ] Add troubleshooting guide for common Stripe issues
- [ ] Document the fee calculation formula with examples

---

## Quick Fixes (Copy-Paste Ready)

### Fix README.md Environment Variables Section

Replace this section in README.md (lines 180-215):

```markdown
### Backend (.env)

```env
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server
PORT=4242
# For local dev: http://localhost:5173 (npm)
# For Docker dev/prod: http://localhost:8080
FRONTEND_ORIGIN=http://localhost:8080
API_BASE_URL=http://localhost:4242

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/stripe_portal

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Admin Authentication (JWT)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme_secure_password
JWT_SECRET=your_jwt_secret_minimum_32_characters_long
JWT_EXPIRY=1h

# Payment Config
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100
```

**Admin Authentication:** The backend uses JWT tokens for admin endpoints (client list, status management). Configure `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `JWT_SECRET` (minimum 32 characters). `JWT_EXPIRY` is optional (defaults to `1h`). See `backend/.env.example` for detailed documentation.
```

With this:

```markdown
### Backend (.env)

```env
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server
PORT=4242
# For local dev: http://localhost:5173 (npm)
# For Docker dev/prod: http://localhost:8080
FRONTEND_ORIGIN=http://localhost:8080
API_BASE_URL=http://localhost:4242

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/stripe_portal

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Admin Authentication (JWT)
JWT_SECRET=your_jwt_secret_minimum_32_characters_long
JWT_EXPIRY=1h

# First-run Admin Setup (remove after setup)
ALLOW_ADMIN_SETUP=true
ADMIN_SETUP_TOKEN=your_secure_setup_token

# Payment Config
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100
```

**Admin Authentication:** The backend uses database-backed admin accounts with JWT tokens. On first run, enable `ALLOW_ADMIN_SETUP=true`, use `/auth/setup` to create credentials, then confirm with `/auth/confirm-bootstrap`. After setup, set `ALLOW_ADMIN_SETUP=false`. See `.env.example` for detailed documentation.
```

### Add to API_DOCS.md - Missing Endpoints

Add this section after "Webhooks" (around line 835):

```markdown
### Configuration

#### `GET /api/v1/config`

No auth required. Returns public configuration used by the frontend.

**Response `200`:**
```json
{
  "useCheckout": true
}
```

This indicates whether the backend is configured to use Stripe Checkout (`true`) or PaymentIntent (`false`) mode.

---

### Products

#### `GET /api/v1/products`

**Auth: Admin JWT**

List Stripe products for the workspace.

**Query params:**
- `workspace` (optional) — `"dfwsc_services"` or `"client_portal"` (default: `"client_portal"`)
- `limit` (optional) — Max results (1-100, default: 10)

**Response `200`:**
```json
{
  "workspace": "client_portal",
  "data": [
    {
      "id": "prod_xxx",
      "name": "Monthly Retainer",
      "description": "...",
      "active": true
    }
  ],
  "hasMore": false
}
```

#### `POST /api/v1/products`

**Auth: Admin JWT**

Create a new Stripe product.

**Request:**
```json
{
  "workspace": "client_portal",
  "name": "Consulting Package",
  "description": "10 hours of consulting"
}
```

**Response `201`:** Created product object.

---

### Stripe Customers

#### `GET /api/v1/stripe-customers`

**Auth: Admin JWT**

List Stripe customers linked to workspace clients.

**Query params:**
- `workspace` (optional) — Filter by workspace
- `clientId` (optional) — Filter by specific client
- `limit` (optional) — Max results (1-100, default: 10)

**Response `200`:** Array of customer objects with `stripeCustomerId`, `email`, `name`, etc.

#### `POST /api/v1/stripe-customers`

**Auth: Admin JWT**

Create a Stripe customer for a client.

**Request:**
```json
{
  "clientId": "abc123",
  "email": "billing@example.com",
  "name": "Acme Corp"
}
```

**Response `201`:** Created customer object with `stripeCustomerId`.

---

### DFWSC Clients

#### `GET /api/v1/dfwsc-clients`

**Auth: Admin JWT**

List all clients in the `dfwsc_services` workspace (internal DFWSC clients).

Same response format as `GET /api/v1/clients`.

---

### Settings

#### `GET /api/v1/settings`

**Auth: Admin JWT**

Get system settings and defaults.

**Response `200`:**
```json
{
  "defaultPaymentTermsDays": 30,
  "processingFeePercent": 2.5
}
```
```

---

## Testing Checklist

After making documentation changes, verify:

- [ ] All documented endpoints actually exist in code
- [ ] All existing endpoints are documented
- [ ] Environment variable examples work
- [ ] Authentication flow matches actual implementation
- [ ] Database schema matches actual tables

Run these commands to verify:
```bash
# Test health endpoint
curl http://localhost:4242/api/v1/health

# Test config endpoint
curl http://localhost:4242/api/v1/config

# Test auth flow
curl http://localhost:4242/api/v1/auth/setup/status

# List all registered routes (from server logs on startup)
make logs
```
