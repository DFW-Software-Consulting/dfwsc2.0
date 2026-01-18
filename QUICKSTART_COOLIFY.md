# Quick Start: Deploy to Coolify

This is a condensed guide to get dfwsc2.0 running on Coolify at **stripe.dfwsc.com**.

For complete details, see [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md)

## Pre-Flight Checklist

- [ ] Coolify instance is running
- [ ] DNS: `stripe.dfwsc.com` points to your Coolify server
- [ ] Stripe API keys ready (test or production)
- [ ] SMTP credentials for email notifications
- [ ] Remove old `stripe_payment_portal` deployment if it exists

## 5-Minute Setup

### 1. Configure DNS
```bash
# Verify stripe.dfwsc.com points to your Coolify server
dig stripe.dfwsc.com
```

If not configured, add an A record:
- **Name**: `stripe`
- **Type**: `A`
- **Value**: Your Coolify server IP address

### 2. Create Project in Coolify

1. Open Coolify dashboard
2. Click **+ New Resource** → **Docker Compose**
3. Choose **Git Repository**
4. Enter repository: `git@github.com:DFW-Software-Consulting/dfwsc2.0.git`
5. Branch: `monorepo`
6. Docker Compose file: `docker-compose.coolify.yml`

### 3. Set Environment Variables

Copy from `.env.production.example` and set these in Coolify:

**Required:**
```bash
POSTGRES_PASSWORD=<secure-password>
STRIPE_SECRET_KEY=sk_test_... or sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_test_... or pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
JWT_SECRET=<run: openssl rand -base64 48>
ADMIN_PASSWORD=<secure-password>
SMTP_HOST=smtp.gmail.com
SMTP_USER=your-email@gmail.com
SMTP_PASS=<app-password>
SMTP_FROM=noreply@dfwsc.com
```

**Optional (with defaults):**
```bash
POSTGRES_USER=postgres
POSTGRES_DB=stripe_portal
ADMIN_USERNAME=admin
SMTP_PORT=587
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100
JWT_EXPIRY=1h
```

### 4. Configure Domain

In Coolify project settings:
- Add domain: `stripe.dfwsc.com`
- Enable HTTPS (automatic Let's Encrypt)

### 5. Deploy

Click **Deploy** button and wait for:
- ✅ PostgreSQL container starts
- ✅ Backend API builds and starts
- ✅ Frontend builds and starts
- ✅ SSL certificate provisioned

### 6. Run Database Migrations

Open terminal for the `api` service in Coolify:
```bash
npm run db:migrate
```

### 7. Verify

```bash
# Health check
curl https://stripe.dfwsc.com/api/v1/health

# Should return: {"status":"ok","timestamp":"..."}
```

Visit: https://stripe.dfwsc.com

### 8. Configure Stripe Webhook

In Stripe Dashboard:
1. Go to **Developers** → **Webhooks**
2. Add endpoint: `https://stripe.dfwsc.com/api/v1/webhooks/stripe`
3. Select events: `checkout.session.completed`, `payment_intent.succeeded`
4. Update `STRIPE_WEBHOOK_SECRET` in Coolify with the signing secret

## Architecture

```
stripe.dfwsc.com (HTTPS/SSL)
          ↓
    Traefik Proxy
          ↓
  Frontend (nginx:80) ← serves React app + proxies /api/
          ↓
  Backend (api:4242) ← Fastify + TypeScript
          ↓
  PostgreSQL (db:5432)
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Can't access site | Check DNS with `dig stripe.dfwsc.com` |
| 502 Bad Gateway | Check API logs in Coolify dashboard |
| Database errors | Verify migrations ran: `npm run db:migrate` |
| SSL not working | Wait 1-2 minutes for Let's Encrypt provisioning |

## Next Steps

- Test payment flow end-to-end
- Configure backups for PostgreSQL
- Set up monitoring/alerting
- Review security settings

## Support

Full documentation: [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md)
