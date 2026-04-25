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
   cp backend/.env.example backend/.env
   # Edit backend/.env with your Stripe keys, database URL, SMTP settings
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

If you run the frontend via `docker-compose.dev.yml`, it is served on `http://localhost:1919`.

#### Option 2: Docker Dev Stack (Full stack in containers)
```bash
docker compose -f docker-compose.dev.yml up --build
```

- **Web UI:** http://localhost:1919
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

Services (default):
- **Web UI:** http://localhost:8080
- **API:** http://localhost:4242
- **Mailhog:** http://localhost:8025

For the Docker dev setup in `docker-compose.dev.yml`, the UI runs at `http://localhost:1919`.

If you want the UI on port 80, change the `web` service port mapping in `docker-compose.base.yml`.

### Container Healthchecks & Logs
- **Healthchecks**: `GET /api/v1/health` for the API; verify container status with `docker compose ps`.
- **Logs**: `docker compose logs -f api` (backend) and `docker compose logs -f web` (frontend/nginx).

## 📡 API Routes

All API routes are prefixed with `/api/v1`:

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/v1/health` | Health check | Public |
| POST | `/api/v1/auth/login` | Admin login (returns JWT token) | Public |
| GET | `/api/v1/auth/setup/status` | Bootstrap setup status | Public |
| POST | `/api/v1/auth/setup` | First-run admin setup | Optional token |
| GET | `/api/v1/clients` | List all clients (includes CRM columns) | Admin (JWT) |
| PATCH | `/api/v1/clients/:id` | Update client config | Admin (JWT) |
| POST | `/api/v1/accounts` | Create client account | Admin (JWT) |
| POST | `/api/v1/clients/sync-payment-status` | Trigger Stripe payment status sync | Admin (JWT) |
| POST | `/api/v1/clients/:id/suspend` | Suspend a client | Admin (JWT) |
| POST | `/api/v1/clients/:id/reinstate` | Reinstate a suspended client | Admin (JWT) |
| POST | `/api/v1/dfwsc/leads` | Create a lead (no Stripe) | Admin (JWT) |
| POST | `/api/v1/dfwsc/leads/:id/convert` | Convert lead to client (creates Stripe customer) | Admin (JWT) |
| POST | `/api/v1/onboard-client/initiate` | Send onboarding email | Admin (JWT) |
| POST | `/api/v1/onboard-client/resend` | Resend onboarding email | Admin (JWT) |
| GET | `/api/v1/onboard-client` | Get Stripe onboarding link | Public |
| GET | `/api/v1/connect/callback` | Stripe Connect callback | Public |
| GET | `/api/v1/connect/refresh` | Refresh Stripe account link | Public |
| POST | `/api/v1/payments/create` | Create payment | Client (API key) |
| GET | `/api/v1/reports/payments` | List payments | Admin (JWT) |
| GET | `/api/v1/groups` | List client groups | Admin (JWT) |
| POST | `/api/v1/groups` | Create client group | Admin (JWT) |
| PATCH | `/api/v1/groups/:id` | Update group config | Admin (JWT) |
| GET | `/api/v1/invoices` | List invoices | Admin (JWT) |
| POST | `/api/v1/invoices` | Create invoice (appends Nextcloud ledger) | Admin (JWT) |
| PATCH | `/api/v1/invoices/:id` | Cancel invoice (updates Nextcloud ledger) | Admin (JWT) |
| POST | `/api/v1/invoices/backfill-ledger` | Seed Nextcloud ledger from Stripe | Admin (JWT) |
| GET | `/api/v1/invoices/pay/:token` | Fetch invoice by token | Public |
| POST | `/api/v1/invoices/pay/:token` | Submit invoice payment | Public |
| GET | `/api/v1/subscriptions` | List subscriptions | Admin (JWT) |
| POST | `/api/v1/subscriptions` | Create subscription | Admin (JWT) |
| GET | `/api/v1/subscriptions/:id` | Get subscription + invoices | Admin (JWT) |
| PATCH | `/api/v1/subscriptions/:id` | Update subscription status | Admin (JWT) |
| POST | `/api/v1/webhooks/stripe` | Stripe webhooks | Stripe |

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
# For Docker dev/prod: http://localhost:8080
FRONTEND_ORIGIN=http://localhost:8080
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

# First-run Admin Setup (remove after setup)
ALLOW_ADMIN_SETUP=true
ADMIN_SETUP_TOKEN=your_secure_setup_token
SETUP_FLAG_PATH=/data/admin-setup-used

# Payment Config
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100

# Nextcloud Ledger (optional — ledger sync is skipped if not set)
NEXTCLOUD_URL=https://cloud.dfwsc.com
NEXTCLOUD_USER=MessyGinger0804
NEXTCLOUD_APP_PASSWORD=<app-password-from-nextcloud-settings>
```

**Admin Authentication:** The backend uses database-backed admin accounts with JWT tokens. On first run, enable `ALLOW_ADMIN_SETUP=true`, use `/auth/setup` to create credentials, then confirm with `/auth/confirm-bootstrap`. After setup, set `ALLOW_ADMIN_SETUP=false`. See `.env.example` for detailed documentation.

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
- `npm run build:frontend` - Build React app to backend/public
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
| [DATABASE.md](./docs/DATABASE.md) | Schema, Drizzle, migrations |
| [STRIPE.md](./docs/STRIPE.md) | Stripe Connect, webhooks, payment flows |
| [CRM.md](./docs/CRM.md) | Lead pipeline, client lifecycle, payment sync |
| [NEXTCLOUD.md](./docs/NEXTCLOUD.md) | Invoice ledger integration and WebDAV setup |
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
- `dfwsc2.0/front` - React frontend (built and served by nginx)
- `dfwsc2.0/backend` - Fastify backend (API only)

**Benefits:**
- ✅ Frontend and API deploy independently
- ✅ Easy to move API or UI to different hosts later
- ✅ Clean separation of concerns

## 📝 License

ISC

## 👥 Author

DFW Software Consulting - Jeremy Ashley
