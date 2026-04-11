# Coolify Deployment Guide for DFWSC Payment Portal

This guide explains how to deploy the DFW Software Consulting payment portal to Coolify as separate services while maintaining the monorepo structure.

## Overview

The application consists of three main services:
1. **Database** - PostgreSQL 17
2. **Backend** - Fastify/TypeScript API server
3. **Frontend** - React application served by Nginx with API proxying

All services can be deployed independently on Coolify while sharing the same monorepo.

## Service Configuration

### 1. Database Service
- **Type**: PostgreSQL 17 (Use Coolify's managed PostgreSQL or custom container)
- **Port**: 5432 (internal only)
- **Environment Variables**:
  - POSTGRES_USER=postgres
  - POSTGRES_PASSWORD=postgres
  - POSTGRES_DB=stripe_portal
- **Storage**: Enable persistent volume for data directory
- **Healthcheck**: `pg_isready -U postgres -d stripe_portal`

### 2. Backend Service (API)
- **Source**: `./backend` directory
- **Build**: Use existing Dockerfile (multi-stage production build)
- **Port**: 4242 (expose for internal communication)
- **Environment Variables**:
  ```
  STRIPE_SECRET_KEY=your_stripe_secret_key
  STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
  DATABASE_URL=<postgres-connection-url>
  FRONTEND_ORIGIN=https://your-frontend-domain.com
  JWT_SECRET=your_jwt_secret_minimum_32_chars
  USE_CHECKOUT=true
  DEFAULT_PROCESS_FEE_CENTS=100
  SMTP_HOST=your_smtp_host
  SMTP_PORT=your_smtp_port
  SMTP_USER=your_smtp_user
  SMTP_PASS=your_smtp_password
  SMTP_FROM=noreply@yourdomain.com
  API_BASE_URL=https://your-backend-domain.com
  ALLOW_ADMIN_SETUP=false  # Set to true only during initial admin setup
  ```
- **Startup Command**: `npm run db:migrate && npm run start` (handled by Dockerfile)
- **Dependencies**: Database service must be healthy first
- **Healthcheck**: `curl -f http://localhost:4242/api/v1/health || exit 1`

### 3. Frontend Service (React + Nginx)
- **Source**: `./front` directory
- **Build**: Multi-stage Dockerfile (see below)
- **Port**: 80 (expose as HTTP/HTTPS via Coolify)
- **Environment Variables** (minimal):
  - VITE_API_URL=/api/v1 (optional, used during build if needed)
- **Configuration**: Uses existing `front/nginx.conf` which:
  - Serves React static files from root path (`/`)
  - Proxies `/api/*` requests to backend service
  - Proxies `/docs/*` requests to backend service (Swagger UI)
- **Dependencies**: Backend service
- **Healthcheck**: `curl -f http://localhost || exit 1`

## Dockerfiles

### Backend Dockerfile (already exists)
The backend/Dockerfile is already optimized for production:
```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS builder
ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY drizzle.config.ts ./drizzle.config.ts
COPY drizzle ./drizzle
COPY src ./src

RUN npm run build:server

FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build-dist ./dist
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle ./drizzle

USER node

CMD ["sh", "-c", "npm run db:migrate && npm run start"]
```

### Frontend Dockerfile (recommended)
Create this file at `front/Dockerfile`:
```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Serve stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
```

## Nginx Configuration
The existing `front/nginx.conf` is already configured correctly:
- Serves React app from root
- Proxies `/api/*` to backend service
- Proxies `/docs/*` to backend service (Swagger UI)
- Includes security headers and compression

## Deployment Sequence

### Phase 1: Infrastructure Setup
1. **Create Database Service**
   - Choose PostgreSQL 17
   - Set environment variables: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
   - Enable persistent storage
   - Save and wait for service to become healthy

2. **Create Backend Service**
   - Set source to your repository
   - Set build context to `./backend`
   - Use existing Dockerfile
   - Add all environment variables from the list above
   - Set dependency on Database service
   - Add healthcheck: `curl -f http://localhost:4242/api/v1/health || exit 1`
   - Save and deploy

3. **Create Frontend Service**
   - Set source to your repository
   - Set build context to `./front`
   - Use the frontend Dockerfile (or Coolify's Node.js buildpacks)
   - Add minimal environment variables (VITE_API_URL=/api/v1 if needed)
   - Set dependency on Backend service
   - Add healthcheck: `curl -f http://localhost || exit 1`
   - Save and deploy

### Phase 2: Configuration & Testing
1. **Verify Database Connection**
   - Check backend logs for successful connection and migration completion

2. **Test API Endpoints**
   - Access backend health: `https://[backend-service].coolify.app/api/v1/health`
   - Access Swagger docs: `https://[backend-service].coolify.app/docs/`

3. **Test Frontend**
   - Access frontend: `https://[frontend-service].coolify.app`
   - Verify React app loads correctly
   - Test API proxy: Check network tab for requests to `/api/*` reaching backend

4. **End-to-End Testing**
   - Test admin login and setup
   - Test client onboarding flow
   - Test payment processing (with Stripe test keys)
   - Verify email delivery
   - Test webhook handling

## Coolify-Specific Recommendations

### Service Dependencies
- Use Coolify's dependency management to ensure services start in correct order:
  - Database → Backend → Frontend

### Environment Management
- Use Coolify's built-in secrets management for:
  - STRIPE_SECRET_KEY
  - STRIPE_WEBHOOK_SECRET
  - JWT_SECRET
  - Database passwords
  - SMTP credentials
- Store non-sensitive configuration in environment variables

### Monitoring & Logging
- Enable log aggregation for all services
- Set up resource monitoring (CPU, memory, disk)
- Configure alerting for service failures

### Backup Strategy
- If using Coolify's managed PostgreSQL, enable automatic backups
- If using self-hosted PostgreSQL, configure backup strategy
- Consider backing up uploaded files if you add file storage later

### SSL/TLS
- Coolify automatically handles SSL termination
- No need to configure SSL in your services
- Access via HTTPS://your-domain.com

## Troubleshooting

### Common Issues
1. **Database Connection Failures**
   - Verify DATABASE_URL uses correct service name
   - Check that database service is healthy before starting backend
   - Confirm username/password/database name match

2. **API Proxy Not Working**
   - Verify nginx.conf is being used in frontend service
   - Check that backend service is healthy and accessible
   - Ensure frontend service depends on backend service

3. **Build Failures**
   - Check that all dependencies are in package.json
   - Verify node_modules are not being excluded incorrectly
   - Check build output for specific error messages

4. **Environment Variable Issues**
   - Double-check variable names match exactly
   - Verify secrets are properly injected
   - Check for extra spaces or quotes in values

## Maintenance

### Updates
1. Push changes to your repository
2. Coolify will detect changes based on your monitor paths configuration
3. Each service will rebuild and redeploy if its source changed
4. Services will restart in dependency order

### Scaling
- Scale frontend independently based on web traffic
- Scale backend based on API usage
- Database scaling handled by Coolify's PostgreSQL offering

### Environment Promotion
- Use the same configuration for dev/staging/prod
- Only change environment variable values
- Consider using Coolify's environment promotion features

## Files Reference

Key files for Coolify deployment:
- `backend/Dockerfile` - Production backend build
- `front/Dockerfile` - Recommended frontend build (create this)
- `front/nginx.conf` - Already configured for API proxying
- `backend/.env` - Reference for environment variable names (use values, don't commit file)
- `docker-compose.prod.yml` - Reference for service relationships (see commit 701b8d2e2b38a5c5f7d1bba47bef57502e15eadb)

This setup gives you the benefits of both worlds:
- **Development**: Monorepo simplicity with atomic commits and shared tooling
- **Deployment**: Microservice flexibility with independent scaling, fault isolation, and deployment
