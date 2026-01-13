# Environment Setup

Create a `.env` file at the project root based on the template below. These variables power Fastify configuration, Stripe access, database connectivity, and SMTP email delivery.

```env
# Stripe credentials
STRIPE_SECRET_KEY=sk_test_********************************
STRIPE_WEBHOOK_SECRET=whsec_********************************

# Application runtime
PORT=4242
FRONTEND_ORIGIN=http://localhost:5173
USE_CHECKOUT=false
# Optional when the public URL differs from the local host header
# API_BASE_URL=https://api.example.com

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/stripe_payment_portal

# SMTP (token emails)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=no-reply@example.com
SMTP_PASS=supersecretpassword
# Optional nicety for recipients
# SMTP_FROM=DFW Software Consulting <no-reply@example.com>

# Admin Authentication (JWT-based)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme_secure_password
JWT_SECRET=your_jwt_secret_minimum_32_characters_long_random_string
# Optional: JWT token expiration (default: 1h)
JWT_EXPIRY=1h

# Optional shared secret for extra admin authentication (deprecated, use JWT auth above)
# ADMIN_API_KEY=change-me
```

## Admin Authentication

The admin authentication system uses JWT (JSON Web Tokens) to secure client management endpoints. This provides access to:
- Admin login (`POST /api/v1/auth/login`)
- Client list retrieval (`GET /api/v1/clients`)
- Client status management (`PATCH /api/v1/clients/:id`)

### Configuration Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_USERNAME` | Yes | - | Username for admin login. Use a non-obvious value in production. |
| `ADMIN_PASSWORD` | Yes | - | Password for admin authentication. Supports plain text (dev) or bcrypt hash (production). |
| `JWT_SECRET` | Yes | - | Secret key for signing JWT tokens. **Must be minimum 32 characters**. Generate with: `openssl rand -base64 32` |
| `JWT_EXPIRY` | No | `1h` | JWT token expiration time. Formats: `1h`, `30m`, `7d`, `24h`. Shorter = more secure. |

### Security Best Practices

1. **Password Security**:
   - Development: Plain text passwords are acceptable for local testing
   - Production: Use bcrypt hashed passwords (e.g., `$2b$10$...`)
   - Generate hash: `bcrypt.hash('your_password', 10)` in Node.js
   - Never commit plain text production passwords to version control

2. **JWT Secret Management**:
   - Generate cryptographically secure random strings (minimum 32 characters)
   - Rotate secrets periodically (every 90 days recommended)
   - Store in secure secret management system (e.g., AWS Secrets Manager, Vault)
   - Use different secrets for development, staging, and production environments

3. **Token Expiry Tuning**:
   - Shorter expiry times reduce attack window but require more frequent re-authentication
   - Recommended: `1h` for production, `8h` for development
   - Consider implementing refresh tokens for better UX in production

### Example Configuration

```env
# Development
ADMIN_USERNAME=admin
ADMIN_PASSWORD=dev_password_123
JWT_SECRET=dev_secret_minimum_32_characters_long_for_testing
JWT_EXPIRY=8h

# Production
ADMIN_USERNAME=dfwsc_admin_2024
ADMIN_PASSWORD=$2b$10$rKjZxN5vP8xQ2wY4sT6uU.eH9xF3vB1cL5mJ7nK8pR9tQ0sV1wX2y
JWT_SECRET=<generated-via-openssl-rand-base64-32>
JWT_EXPIRY=1h
```

## Notes
- `USE_CHECKOUT` accepts only `true` or `false`; invalid values will halt server startup.
- `FRONTEND_ORIGIN` should match the origin serving your frontend so CORS and redirect URLs align.
- Ensure `DATABASE_URL` points to a PostgreSQL instance accessible from the server environment.
- Commit `.env` to secrets storage (e.g., 1Password, Vault) rather than the repository.
- Admin authentication requires all three variables (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`) to be set; the server will fail to start if any are missing.
- `JWT_EXPIRY` is optional and defaults to `1h` if not specified.

## Verification Steps
1. Copy the template: `cp env.example .env` and edit values.
2. Run `npm run dev`; the server logs masked env values if everything is configured.
3. Execute `npm test` to confirm the app can boot and exercise routes with the provided configuration.
4. Test admin authentication:
   - Send POST request to `/api/v1/auth/login` with your `ADMIN_USERNAME` and `ADMIN_PASSWORD`
   - Verify you receive a JWT token in the response
   - Use the token in Authorization header (`Bearer <token>`) for protected endpoints
   - Test token expiration by waiting beyond `JWT_EXPIRY` duration
