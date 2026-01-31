# DFWSC Frontend

React + Vite application serving the DFW Software Consulting marketing website and Stripe payment portal client onboarding interface.

## What This Is

This frontend provides:
- **Marketing Website**: Company homepage, pricing, team pages
- **Client Onboarding**: Stripe Connect integration for new clients
- **Admin Dashboard**: Client management and payment oversight
- **Payment Processing**: Integration with Stripe for client payments

## Tech Stack

- **React 18** with React Router 6
- **Vite** for build tooling and dev server
- **TailwindCSS v4** for styling
- **Vitest** for testing

## Development

### Local Development (Hot Reload)
```bash
npm install
npm run dev
```
Runs on `http://localhost:5173` with API calls to `http://localhost:4242/api/v1`

### Docker Development
```bash
# From project root
docker compose -f docker-compose.dev.yml up
```
Runs on `http://localhost:1919` with API calls to the containerized backend

## Testing

```bash
npm test
```
Tests use Vitest with core flow coverage in `src/__tests__/coreFlows.test.jsx`

## Application Routes

- `/` - Marketing homepage
- `/pricing` - Service pricing information  
- `/team` - Team member profiles
- `/onboard` - Client onboarding and admin dashboard

## Admin Dashboard

Access the admin interface at `/onboard`:

1. Click "Admin Login" 
2. Use credentials from backend `.env` (`ADMIN_USERNAME`/`ADMIN_PASSWORD`)
3. Manage clients, create accounts, and initiate onboarding
4. View payment reports and client status

Admin features:
- Client list with status management (active/inactive)
- Create new client accounts
- Send onboarding emails
- Payment reporting

## Environment Configuration

Copy `.env.example` to `.env` and configure:

```env
# For local development
VITE_API_URL=http://localhost:4242/api/v1

# For Docker (nginx proxies /api to backend)
VITE_API_URL=/api/v1
```

## Production Build

The `Dockerfile` creates a production build:
1. Builds React app with Vite
2. Serves via nginx
3. Proxies `/api/*` requests to backend container

Built assets are served from nginx with API requests proxied to the backend service.
