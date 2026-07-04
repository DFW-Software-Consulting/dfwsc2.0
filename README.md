# DFW Software Consulting - Full Stack Payment Portal

Monorepo with a React frontend and a Fastify API for Stripe payments and onboarding.

## 📁 Project Structure

```
dfwsc2.0/
├── front/                    # React frontend (marketing + onboarding)
│   ├── src/
│   │   ├── pages/           # React pages (Home, Pricing, Team, OnboardClient, etc.)
│   │   ├── components/      # Reusable React components
│   │   └── assets/          # Images, icons, etc.
│   ├── vite.config.js
│   ├── Dockerfile           # Builds React and serves via nginx
│   └── nginx.conf           # Proxies /api to the backend
│
├── backend/                  # Fastify API server
│   ├── src/
│   │   ├── routes/          # API routes (/api/v1/*)
│   │   ├── lib/             # Utilities (Stripe, mailer, auth, etc.)
│   │   └── db/              # Database schema & client
│   ├── package.json
│   └── Dockerfile           # API-only Docker image
│
├── docker-compose.base.yml   # Base services config (extended by dev/prod)
├── package.json              # Root monorepo scripts
└── .gitignore                # Ignore node_modules, build outputs, etc.
```

## 🚀 Tech Stack

### Frontend
- **React 18** - UI framework
- **Vite** - Build tool & dev server
- **React Router 6** - Client-side routing
- **TanStack Query v5** - Server state management & data fetching
- **TailwindCSS v4** - Utility-first CSS

### Backend
- **Node.js 20** - Runtime
- **Fastify 5** - Web framework
- **TypeScript** - Type safety
- **PostgreSQL 17** - Database
- **Drizzle ORM** - Type-safe database toolkit
- **Stripe API** - Payment processing (Connect)
- **Nodemailer** - Email delivery

## 🛠️ Development

### Prerequisites
- Node.js 20+
- PostgreSQL 17
- npm or yarn

### Setup

1. **Install dependencies:**
   ```bash
   npm run install:all
   ```

2. **Configure environment:**
   ```bash
   # Backend configuration
   cp .env.example .env
   # Edit .env with your Stripe keys, database URL, SMTP settings
   ```

3. **Run database migrations:**
   ```bash
   npm run db:migrate
   ```

### Development Options

#### Option 1: Hot Reload (Recommended for development)
Run frontend and backend separately with hot reload:

```bash
# Terminal 1 - Backend API (port 4242)
npm run dev:backend

# Terminal 2 - Frontend dev server (port 5173)
npm run dev:frontend
```

- **Frontend:** http://localhost:5173 (with hot reload)
- **Backend:** http://localhost:4242
- Frontend makes API calls to backend at http://localhost:4242/api/v1/*

If you run the frontend via `docker-compose.dev.yml`, it is served on `http://localhost:5173`.

#### Option 2: Docker Dev Stack (Full stack in containers)
```bash
docker compose -f docker-compose.dev.yml up --build
```

- **Web UI:** http://localhost:5173
- **API:** http://localhost:4242
- **Mailhog:** http://localhost:8025
- **Stripe CLI:** forwards webhooks to `/api/v1/webhooks/stripe`

### Building for Production

```bash
# Build both frontend and backend
npm run build

# Start production server
npm start
```

## 🐳 Docker Deployment

### Compose (Recommended)
```bash
make down
make up-build
```

`make up-build` starts the DEV stack (base + dev compose):
- **Web UI:** http://localhost:5173
- **API:** http://localhost:4242
- **Mailhog:** http://localhost:8025

The production stack (`make prod` → `docker-compose.prod.yml`) runs ONLY the `migrator` and `api` services — there is no bundled web container. The frontend is built and served separately (e.g. its own nginx container on Coolify).

### Container Healthchecks & Logs
- **Healthchecks**: `GET /api/v1/health` for the API; verify container status with `docker compose ps`.
- **Logs**: `docker compose logs -f api` (backend) and `docker compose logs -f web` (frontend/nginx).

## 📡 API Routes

Most API routes are prefixed with `/api/v1` (the runtime config script `/app-config.js` is the one exception, served at the root):

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/app-config.js` | Runtime API base URL script (served at root, no `/api/v1` prefix) | Public |
| GET | `/api/v1/health` | Health check (verifies DB connectivity) | Public |
| POST | `/api/v1/auth/login` | Admin login (returns JWT token) | Public |
| GET | `/api/v1/auth/setup/status` | Bootstrap setup status | Public |
| POST | `/api/v1/auth/setup` | Deprecated — always returns 410 Gone | Public |
| POST | `/api/v1/auth/confirm-bootstrap` | Confirm bootstrap admin credentials | Admin (JWT) |
| GET | `/api/v1/clients` | List clients (requires `workspace` query) | Admin (JWT) |
| GET | `/api/v1/clients/:id` | Get a single client | Admin (JWT) |
| PATCH | `/api/v1/clients/:id` | Update client config | Admin (JWT) |
| POST | `/api/v1/accounts` | Create client + onboarding token (no email) | Admin (JWT) |
| POST | `/api/v1/onboard-client/initiate` | Create client and email onboarding link | Admin (JWT) |
| POST | `/api/v1/onboard-client/resend` | Resend onboarding email | Admin (JWT) |
| GET | `/api/v1/onboard-client` | Get Stripe onboarding link (JSON) by token | Public |
| GET | `/api/v1/connect/refresh` | Refresh Stripe account link (redirect) | Public |
| GET | `/api/v1/connect/callback` | Stripe Connect return callback | Public |
| POST | `/api/v1/payments/create` | Create payment (PaymentIntent or Checkout) | Client (API key) or Admin (JWT) |
| GET | `/api/v1/reports/payments` | List payments | Admin (JWT) |
| GET | `/api/v1/groups` | List client groups | Admin (JWT) |
| POST | `/api/v1/groups` | Create client group | Admin (JWT) |
| PATCH | `/api/v1/groups/:id` | Update group config | Admin (JWT) |
| GET | `/api/v1/products` | List Stripe products | Admin (JWT) |
| POST | `/api/v1/products` | Create Stripe product + price | Admin (JWT) |
| GET | `/api/v1/tax-rates` | List active Stripe tax rates | Admin (JWT) |
| GET | `/api/v1/settings` | Fetch global settings | Admin (JWT) |
| PATCH | `/api/v1/settings/:key` | Update a global setting | Admin (JWT) |
| GET | `/api/v1/metrics` | Prometheus metrics (requires METRICS_TOKEN; 404 if unset) | Token |
| POST | `/api/v1/webhooks/stripe` | Stripe webhooks | Stripe signature |

## 🌐 Frontend Routes

React Router handles these client-side routes:

- `/` - Home page
- `/pricing` - Pricing page
- `/team` - Team page
- `/onboard?token=<token>` - Client Stripe onboarding

## 🔐 Environment Variables

### Backend (.env)

```env
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server
PORT=4242
# For local dev: http://localhost:5173 (npm)
# For Docker dev (docker-compose): http://localhost:5173
FRONTEND_ORIGIN=http://localhost:5173
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

# First-run Admin Bootstrap (remove after setup)
ALLOW_ADMIN_SETUP=true
ADMIN_USERNAME=your-admin-username
ADMIN_PASSWORD=a-strong-password-12-chars-min

# Payment Config
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100

```

**Admin Authentication:** The backend uses database-backed admin accounts with JWT tokens. On first run, set `ADMIN_USERNAME`/`ADMIN_PASSWORD` (with `ALLOW_ADMIN_SETUP=true`) to bootstrap the first admin from env vars, log in, then confirm the credentials via `/auth/confirm-bootstrap`. After confirming, set `ALLOW_ADMIN_SETUP=false`. The `/auth/setup` endpoint is deprecated and always returns 410 Gone. See `.env.example` for detailed documentation.

### Frontend (.env)

```env
# In docker, nginx proxies /api to the API container
VITE_API_URL=/api/v1

# For local dev without nginx, use:
# VITE_API_URL=http://localhost:4242/api/v1
```

## 📦 NPM Scripts

### Root (Monorepo)
- `npm run dev` - Start backend
- `npm run dev:frontend` - Start frontend dev server
- `npm run dev:backend` - Start backend dev server
- `npm run build` - Build frontend + backend
- `npm run build:frontend` - Build React static assets (output: front/build-dist)
- `npm run build:backend` - Compile TypeScript backend
- `npm run start` - Start production server
- `npm run install:all` - Install all dependencies
- `npm run test` - Run backend tests
- `npm run db:generate` - Generate database migrations
- `npm run db:migrate` - Run database migrations

### Frontend (front/)
- `npm run dev` - Vite dev server
- `npm run build` - Build static assets
- `npm run preview` - Preview production build

### Backend (backend/)
- `npm run dev` - Start with nodemon
- `npm run start` - Start production server
- `npm run build:server` - Compile TypeScript
- `npm run test` - Run Vitest tests
- `npm run db:generate` - Generate migrations
- `npm run db:migrate` - Apply migrations

## 🧪 Testing

```bash
# Run backend tests
npm run test

# Run with UI
cd backend && npm run test:ui
```

## 📚 Documentation

Detailed documentation lives in `docs/`:

| File | What it covers |
|------|----------------|
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System overview, tech stack, data model |
| [BACKEND.md](./docs/BACKEND.md) | API routes, auth, background jobs |
| [FRONTEND.md](./docs/FRONTEND.md) | React, state, and routing |
| [DATABASE.md](./docs/DATABASE.md) | Schema, Drizzle, migrations |
| [STRIPE.md](./docs/STRIPE.md) | Stripe Connect, webhooks, payment flows |
| [STYLES.md](./docs/STYLES.md) | Tailwind v4, UI patterns |

## 🧯 Troubleshooting

- **CORS errors**: ensure `FRONTEND_ORIGIN` matches the UI origin (local vs Docker).
- **Database connection failures**: verify `DATABASE_URL` and container health (`docker compose logs -f db`).
- **Stripe webhook signature errors**: update `STRIPE_WEBHOOK_SECRET` to match the Stripe CLI or dashboard endpoint.
- **Onboarding redirect mismatch**: set `API_BASE_URL` when running behind a reverse proxy.

## 🔄 Migration Notes

This project was recently restructured from separate frontend/backend repos:

**Before:**
- `dfwsc2.0/front` - Deployed to Netlify
- `stripe_payment_portal` - Separate backend

**After:**
- `dfwsc2.0/front` - React frontend (built and served by nginx, deployed as a container on Coolify)
- `dfwsc2.0/backend` - Fastify backend (API only)

**Benefits:**
- ✅ Frontend and API deploy independently
- ✅ Easy to move API or UI to different hosts later
- ✅ Clean separation of concerns

## 📝 License

ISC

## 👥 Author

DFW Software Consulting - Jeremy Ashley
