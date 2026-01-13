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
│   └── Dockerfile.api       # API-only Docker image
│
├── docker-compose.yml        # Runs api + web + db + tooling
├── package.json              # Root monorepo scripts
└── .gitignore                # Ignore node_modules, build outputs, etc.
```

## 🚀 Tech Stack

### Frontend
- **React 18** - UI framework
- **Vite** - Build tool & dev server
- **React Router 6** - Client-side routing
- **TailwindCSS v4** - Utility-first CSS

### Backend
- **Node.js 20** - Runtime
- **Fastify 5** - Web framework
- **TypeScript** - Type safety
- **PostgreSQL 16** - Database
- **Drizzle ORM** - Type-safe database toolkit
- **Stripe API** - Payment processing (Connect)
- **Nodemailer** - Email delivery

## 🛠️ Development

### Prerequisites
- Node.js 20+
- PostgreSQL 14+
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

If you want the UI on port 80, change the `web` service port mapping in `docker-compose.yml`.

## 📡 API Routes

All API routes are prefixed with `/api/v1`:

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/v1/health` | Health check | Public |
| POST | `/api/v1/auth/login` | Admin login (returns JWT token) | Public |
| GET | `/api/v1/clients` | List all clients | Admin (JWT) |
| PATCH | `/api/v1/clients/:id` | Update client status | Admin (JWT) |
| POST | `/api/v1/accounts` | Create client account | Admin |
| POST | `/api/v1/onboard-client/initiate` | Send onboarding email | Admin |
| GET | `/api/v1/onboard-client` | Get Stripe onboarding link | Public |
| GET | `/api/v1/connect/callback` | Stripe Connect callback | Public |
| POST | `/api/v1/payments/create` | Create payment | Admin/Client |
| GET | `/api/v1/reports/payments` | List payments | Admin |
| POST | `/api/v1/webhooks/stripe` | Stripe webhooks | Stripe |

## 🌐 Frontend Routes

React Router handles these client-side routes:

- `/` - Home page
- `/pricing` - Pricing page
- `/team` - Team page
- `/onboard-client?token=<token>` - Client Stripe onboarding

## 🔐 Environment Variables

### Backend (.env)

```env
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server
PORT=4242
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
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme_secure_password
JWT_SECRET=your_jwt_secret_minimum_32_characters_long
JWT_EXPIRY=1h

# Payment Config
USE_CHECKOUT=true
DEFAULT_PROCESS_FEE_CENTS=100
```

**Admin Authentication:** The backend uses JWT tokens for admin endpoints (client list, status management). Configure `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `JWT_SECRET` (minimum 32 characters). `JWT_EXPIRY` is optional (defaults to `1h`). See `backend/.env.example` for detailed documentation.

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

Additional documentation is available in `backend/documentation/`:
- API documentation
- Database schema
- Stripe setup guide
- Email configuration
- Deployment guide

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
