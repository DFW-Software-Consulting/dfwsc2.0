# Coolify Deployment Guide for dfwsc2.0

This guide walks you through deploying the dfwsc2.0 Stripe payment portal to Coolify at **stripe.dfwsc.com**.

## Prerequisites

1. Coolify instance running and accessible
2. DNS record for `stripe.dfwsc.com` pointing to your Coolify server IP
3. Stripe account with API keys
4. SMTP server credentials for email notifications
5. GitHub access to the repository: `git@github.com:DFW-Software-Consulting/dfwsc2.0.git`

## Deployment Steps

### 1. Remove Old Deployment (if exists)

If you have an existing `stripe_payment_portal` deployment in Coolify:

1. Go to Coolify dashboard
2. Find the `stripe_payment_portal` project
3. Stop the services
4. Delete the project
5. Clean up any persistent volumes if needed

### 2. Create New Project in Coolify

1. Log into your Coolify dashboard
2. Click **+ New Resource**
3. Select **Docker Compose**
4. Choose **Git Repository** as source
5. Configure repository:
   - Repository URL: `git@github.com:DFW-Software-Consulting/dfwsc2.0.git`
   - Branch: `main` (or your production branch)
   - Docker Compose file: `docker-compose.coolify.yml`

### 3. Configure Environment Variables

In Coolify, add the following environment variables to your project:

#### Required Variables

```bash
# PostgreSQL Database
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<generate-secure-password>
POSTGRES_DB=stripe_portal

# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_... or sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_live_... or pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# JWT Authentication (generated example below)
JWT_SECRET=M7K1QcPDY/wyEGEVBqPUSBs4jUqvzw1umdrl9j2pg03zSuA25XqI2Q+CjjeI/MoI
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<your-secure-admin-password>

# SMTP Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=<your-app-password>
SMTP_FROM=noreply@dfwsc.com
```

#### Optional Variables (with defaults)

```bash
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100
JWT_EXPIRY=1h
```

#### Generating Secure Secrets

Generate a secure JWT secret:
```bash
openssl rand -base64 48
```

Generate a secure admin password (if using bcrypt):
```bash
node -e "console.log(require('bcrypt').hashSync('your_password', 10))"
```

### 4. Domain Configuration

1. In Coolify project settings, under **Domains**:
   - Add domain: `stripe.dfwsc.com`
   - Enable **HTTPS** (Let's Encrypt will automatically provision SSL)
   - The Traefik labels in `docker-compose.coolify.yml` will handle routing

2. Verify DNS is configured:
   ```bash
   dig stripe.dfwsc.com
   # Should return your Coolify server IP
   ```

### 5. Deploy the Application

1. Click **Deploy** in Coolify dashboard
2. Coolify will:
   - Clone the repository
   - Build the Docker images (frontend and backend)
   - Start the services (db, api, web)
   - Configure Traefik routing with SSL

3. Monitor the deployment logs in real-time

### 6. Post-Deployment: Run Database Migrations

Once deployed, you need to run database migrations:

#### Option A: Using Coolify Terminal

1. Go to your project in Coolify
2. Open terminal for the `api` service
3. Run migrations:
   ```bash
   npm run db:migrate
   ```

#### Option B: Using Docker Exec on Server

SSH into your Coolify server and run:
```bash
docker exec -it <api-container-name> npm run db:migrate
```

Find the container name:
```bash
docker ps | grep dfwsc
```

### 7. Verification

Test the deployment:

1. **Health Check**:
   ```bash
   curl https://stripe.dfwsc.com/api/v1/health
   ```
   Should return: `{"status":"ok","timestamp":"..."}`

2. **Frontend**: Visit https://stripe.dfwsc.com in browser
   - Should load the React application

3. **Admin Login**: Test admin authentication works

4. **Database**: Verify PostgreSQL connection
   ```bash
   docker exec -it <api-container-name> node -e "const db = require('./dist/lib/db').db; db.select().from('clients').limit(1).then(console.log)"
   ```

### 8. Configure Stripe Webhook

1. Log into Stripe Dashboard
2. Go to **Developers** > **Webhooks**
3. Add endpoint:
   - URL: `https://stripe.dfwsc.com/api/v1/webhooks/stripe`
   - Events to send: `checkout.session.completed`, `payment_intent.succeeded`, etc.
4. Copy the webhook signing secret
5. Update `STRIPE_WEBHOOK_SECRET` in Coolify environment variables
6. Redeploy if needed

### 9. Monitoring and Logs

Access logs in Coolify:
- Real-time logs for each service (db, api, web)
- Health check status
- Resource usage (CPU, memory)

### 10. Backup and Maintenance

#### Database Backups

Create periodic backups of PostgreSQL:
```bash
docker exec <db-container-name> pg_dump -U postgres stripe_portal > backup_$(date +%Y%m%d).sql
```

#### Updating the Application

1. Push changes to GitHub repository
2. In Coolify, click **Redeploy**
3. Coolify will pull latest changes and rebuild

## Troubleshooting

### Issue: Services won't start

- Check Coolify logs for build errors
- Verify all required environment variables are set
- Ensure Docker images build successfully

### Issue: Can't access stripe.dfwsc.com

- Verify DNS points to Coolify server: `dig stripe.dfwsc.com`
- Check Traefik configuration in Coolify
- Verify Traefik labels in docker-compose.coolify.yml

### Issue: Database connection errors

- Check `DATABASE_URL` uses `db` as hostname (Docker service name)
- Verify PostgreSQL container is healthy: `docker ps`
- Check database credentials match

### Issue: API returns 502 Bad Gateway

- Check API service health: `docker logs <api-container-name>`
- Verify backend started successfully on port 4242
- Check health endpoint: `docker exec <api-container-name> curl http://localhost:4242/api/v1/health`

### Issue: Frontend can't reach API

- Verify nginx.conf proxy configuration
- Check VITE_API_URL is set to `/api/v1`
- Test API directly: `curl https://stripe.dfwsc.com/api/v1/health`

## Architecture

```
┌─────────────────────┐
│  stripe.dfwsc.com   │
│   (Traefik/SSL)     │
└──────────┬──────────┘
           │
    ┌──────▼──────┐
    │   web:80    │ (nginx serving React + proxy /api/)
    │  (frontend)  │
    └──────┬──────┘
           │ proxy /api/ to api:4242
    ┌──────▼──────┐
    │  api:4242   │ (Fastify backend)
    │  (backend)   │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │   db:5432   │ (PostgreSQL 16)
    │ (database)   │
    └─────────────┘
```

## Security Notes

1. **Never commit secrets** to the repository
2. Use strong passwords for database and admin accounts
3. Keep JWT_SECRET secure and rotate periodically
4. Use Stripe test keys for testing, production keys for production
5. Regularly update dependencies: `npm audit`
6. Enable Coolify's automatic HTTPS with Let's Encrypt

## Support

- Project Repository: https://github.com/DFW-Software-Consulting/dfwsc2.0
- Coolify Documentation: https://coolify.io/docs
- Issues: Create an issue in the GitHub repository
