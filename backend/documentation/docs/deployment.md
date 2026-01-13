# Production Deployment

This document outlines the steps to deploy the Stripe Payment Portal in a production environment using Docker.

## Prerequisites

*   Docker and Docker Compose installed on the host machine.
*   A running reverse proxy network (e.g., created with `docker network create server_proxy`).

## 1. Environment Variables

Create a `.env.prod` file in the root of the project with the following content:

```
# --- Stripe (keep test while staging; switch to live when ready) ---
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...

# Webhook: replace after you create the endpoint in Stripe (step 4)
STRIPE_WEBHOOK_SECRET=whsec_...

# --- App ports / URLs ---
PORT=4242
FRONTEND_ORIGIN=https://your-frontend-domain.com
API_BASE_URL=https://your-api-domain.com

# --- Fees / DB ---
DEFAULT_PROCESS_FEE_CENTS=100

# If you DON'T plan to run Postgres in this compose, point this to your real DB host.
# If you DO run Postgres here, we'll keep this as-is (see compose below).
DATABASE_URL=postgres://dfwsc:devpass@db:5432/dfwsc

# --- SMTP (prod provider) ---
SMTP_HOST=your-smtp-host.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password

USE_CHECKOUT=true

POSTGRES_USER=dfwsc
POSTGRES_PASSWORD=devpass
POSTGRES_DB=dfwsc
```

**Note:** Replace the placeholder values with your actual production credentials and URLs.

## 2. Build and Run the Containers

To build and run the production containers, use the following command:

```bash
docker-compose -f docker-compose.prod.yml up --build -d
```

This command will:

*   Build the Docker image for the application using the `production` stage of the `Dockerfile`.
*   Create and start the `app`, `db`, and `migrator` services in detached mode.
*   The `migrator` service will run the database migrations and then exit.
*   The `app` service will start the application server.

## 3. Reverse Proxy Configuration

The `docker-compose.prod.yml` file is configured to use an external network named `server_proxy`. You need to have a reverse proxy (e.g., Nginx) running in the same network to route traffic to the application.

Here is an example Nginx configuration:

```nginx
server {
    listen 80;
    server_name your-api-domain.com;

    location / {
        proxy_pass http://stripe-portal:4242;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Note:** Replace `your-api-domain.com` with your actual domain and `stripe-portal` with the container name of the application.

## 4. Healthcheck

The application has a healthcheck endpoint at `/health`. The `docker-compose.prod.yml` file is configured to use this endpoint to check the health of the application and restart it if it becomes unresponsive.