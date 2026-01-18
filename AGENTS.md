# DFWSC Stripe Payment Portal

## Project Overview
This is a payment portal for DFW Software Consulting clients that integrates with Stripe for payment processing. The system allows clients to onboard, create payments, and manage their accounts.

## Architecture
- **Backend**: Node.js/TypeScript with Fastify framework
- **Database**: PostgreSQL 14+
- **Frontend**: React application (in `/front` directory)
- **Containerization**: Docker/Docker Compose
- **ORM**: Drizzle ORM for database operations

## Key Features
- Client onboarding with Stripe Connect
- Payment processing via Stripe
- Admin management capabilities
- Webhook handling for Stripe events
- Client status management (active/inactive)

## Docker Environment
The application runs in Docker containers as defined in `docker-compose.yml`:
- `api`: Main backend service (port 4242)
- `web`: Frontend service (port 8080)
- `db`: PostgreSQL database (port 5432)
- `mailhog`: Email testing service (port 8025)

## Development Workflow
1. All development should be done with the Docker containers running
2. The backend code is located in `/backend`
3. Changes to backend code are reflected in the Docker container
4. Database migrations should be run through the Docker environment

## Key Endpoints
- `GET /api/v1/health` - Health check
- `POST /api/v1/auth/login` - Admin authentication
- `PATCH /api/v1/clients/:id` - Update client status (admin only)
- `POST /api/v1/payments/create` - Create payment
- `POST /api/v1/connect/initiate` - Initiate client onboarding

## Working with Docker
- To rebuild: `docker-compose up -d --build`
- To view logs: `docker-compose logs -f api`
- To run commands in container: `docker exec -it dfwsc20-api-1 /bin/sh`
- To run tests in containers: `make test` (stack up) or `make test-up` (start stack + run)

## Important Notes
- The database is persistent in the `pgdata` volume
- Environment variables are loaded from `.env` files
- The client status feature allows soft-deletion of clients by setting status to 'inactive'
- Admin-only endpoints require JWT authentication
- All changes should be tested in the Docker environment to ensure compatibility
