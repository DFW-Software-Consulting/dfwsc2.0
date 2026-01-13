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

# Optional shared secret for extra admin authentication
# ADMIN_API_KEY=change-me
```

## Notes
- `USE_CHECKOUT` accepts only `true` or `false`; invalid values will halt server startup.
- `FRONTEND_ORIGIN` should match the origin serving your frontend so CORS and redirect URLs align.
- Ensure `DATABASE_URL` points to a PostgreSQL instance accessible from the server environment.
- Commit `.env` to secrets storage (e.g., 1Password, Vault) rather than the repository.

## Verification Steps
1. Copy the template: `cp env.example .env` and edit values.
2. Run `npm run dev`; the server logs masked env values if everything is configured.
3. Execute `npm test` to confirm the app can boot and exercise routes with the provided configuration.
