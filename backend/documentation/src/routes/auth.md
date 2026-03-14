# src/routes/auth.ts

## Purpose
Handles admin authentication via JWT tokens and provides a one-time browser-based setup flow for admin credentials.

## Dependencies
- `bcryptjs` - Password hashing
- `jsonwebtoken` - JWT token generation (via `src/lib/auth.ts`)
- Rate limiting via `src/lib/rate-limit.ts`

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_USERNAME` | ✅ | Admin username for login |
| `ADMIN_PASSWORD` | ✅ | Admin password (bcrypt hash recommended, plaintext supported in dev) |
| `JWT_SECRET` | ✅ | Secret key for JWT signing (min 32 chars) |
| `JWT_EXPIRY` | ❌ | Token expiration (default: `1h`) |
| `ALLOW_ADMIN_SETUP` | ❌ | Enable browser-based setup (`true` to enable) |
| `ADMIN_SETUP_TOKEN` | ❌ | Optional token for extra setup protection |
| `SETUP_FLAG_PATH` | ❌ | Path to persist setup flag (default: `/tmp/admin-setup-used`) |
| `NODE_ENV` | ❌ | `production` enforces bcrypt password requirement |

## Routes

### POST `/api/v1/auth/login`
Authenticates admin credentials and returns a JWT token.

**Authentication**: None (public endpoint)

**Rate Limiting**: 5 requests per 15 minutes per IP

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
- `401 Unauthorized`: Invalid credentials
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server configuration error or JWT generation failure

**Security Notes**:
- In production (`NODE_ENV=production`), `ADMIN_PASSWORD` must be a bcrypt hash
- Plaintext passwords trigger a deprecation warning in dev mode
- Failed login attempts are logged with username for security monitoring

---

### GET `/api/v1/auth/setup/status`
Checks if admin setup is allowed (for browser-based credential configuration).

**Authentication**: None (public endpoint)

**Response** (200 OK):
```json
{
  "setupAllowed": true,
  "adminConfigured": false
}
```

**Fields**:
- `setupAllowed`: `true` if setup can proceed (requires `ALLOW_ADMIN_SETUP=true`, no existing password, setup not yet used)
- `adminConfigured`: `true` if `ADMIN_PASSWORD` is already set

---

### POST `/api/v1/auth/setup`
One-time endpoint to generate admin credentials via browser interface.

**Authentication**: None (public endpoint, but requires `X-Setup-Token` header if `ADMIN_SETUP_TOKEN` is configured)

**Rate Limiting**: 3 requests per 15 minutes per IP

**Request Headers**:
```
X-Setup-Token: <your-secret-token>  // Only if ADMIN_SETUP_TOKEN is set
```

**Request Body**:
```json
{
  "username": "admin",
  "password": "secure_password_123"
}
```

**Success Response** (200 OK):
```json
{
  "username": "admin",
  "passwordHash": "$2a$10$XYZ...",
  "instructions": [
    "1. Copy the credentials above",
    "2. Add to your environment configuration:",
    "   ADMIN_USERNAME=admin",
    "   ADMIN_PASSWORD=$2a$10$XYZ...",
    "3. Remove or set ALLOW_ADMIN_SETUP=false",
    "4. Restart your application"
  ]
}
```

**Error Responses**:
- `400 Bad Request`: Missing username/password, password too short (<8 chars)
- `401 Unauthorized`: Invalid setup token
- `403 Forbidden**: Setup not allowed (already configured, setup disabled, or already used)
- `409 Conflict**: Setup already in progress
- `500 Internal Server Error**: Hash generation failure

**Security Notes**:
- Setup can only be used once per server session
- Flag persists across restarts if `SETUP_FLAG_PATH` points to a mounted volume
- Generated password is bcrypt hashed (10 salt rounds)
- Never leave `ALLOW_ADMIN_SETUP=true` in production after setup

---

## Testing & Debugging Notes

### Testing Login
```bash
# Get JWT token
curl -X POST http://localhost:4242/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'
```

### Testing Setup Flow
```bash
# Check setup status
curl http://localhost:4242/api/v1/auth/setup/status

# Initiate setup (with optional token)
curl -X POST http://localhost:4242/api/v1/auth/setup \
  -H "Content-Type: application/json" \
  -H "X-Setup-Token: your-secret-token" \
  -d '{"username":"admin","password":"secure_password_123"}'
```

### Common Issues

**"SECURITY ERROR: ADMIN_PASSWORD must be a bcrypt hash"**
- Occurs when `NODE_ENV=production` and password is plaintext
- Fix: Generate hash with `node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"`

**"Setup has already been used this session"**
- Setup flag was written during this server session
- Fix: Restart server or remove setup flag file at `SETUP_FLAG_PATH`

**JWT generation fails**
- Check that `JWT_SECRET` is set and at least 32 characters
- Generate secure secret: `openssl rand -base64 48`
