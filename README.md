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

### Quick Start

1. **Clone and setup:**
   ```bash
   # Install dependencies
   make install
   
   # Copy environment files
   cp backend/.env.example backend/.env
   cp front/.env.example front/.env
   
   # Edit backend/.env with your Stripe keys and other settings
   # Edit front/.env if needed (defaults work for Docker dev mode)
   ```

2. **Start development environment with hot reload:**
   ```bash
   # Generate and run migrations
   make setup
   
   # Start Docker dev mode with hot reload
   make dev-up-build
   ```

3. **Access your app:**
   - Frontend (Vite HMR): http://localhost:5174
   - Backend API: http://localhost:4242
   - Swagger UI: http://localhost:4242/docs
   - Mailhog: http://localhost:8025

### Development Modes

#### Option 1: Docker with Hot Reload (Recommended)
Development mode with Docker, including hot reload for both frontend and backend:

```bash
# Start dev stack with hot reload
make dev-up-build

# View logs
make dev-logs

# Stop
make dev-down
```

**Services:**
- **Frontend (Vite HMR):** http://localhost:5174
- **Backend (nodemon):** http://localhost:4242
- **Swagger UI:** http://localhost:4242/docs
- **Mailhog:** http://localhost:8025
- **PostgreSQL:** localhost:5432

Code changes in `backend/src` or `front/src` will automatically reload!

#### Option 2: Local Development (No Docker)
Run frontend and backend locally with hot reload:

```bash
# Terminal 1 - Backend API (port 4242)
make dev-backend

# Terminal 2 - Frontend dev server (port 5173)
make dev-frontend
```

**Note:** Requires local PostgreSQL running on port 5432.

### Building for Production

```bash
# Build both frontend and backend
npm run build

# Start production server
npm start
```

## 🐳 Docker Commands

### Development Mode (Hot Reload)
```bash
make dev-up-build    # Build and start dev stack with hot reload
make dev-up          # Start existing dev stack
make dev-down        # Stop dev stack
make dev-logs        # View backend logs
```

### Production Mode
```bash
make up-build        # Build and start production stack
make up              # Start existing stack
make down            # Stop stack
make down-v          # Stop and remove volumes
make logs            # View backend logs
make ps              # Show container status
```

### Database
```bash
make migrate         # Run database migrations
make db-generate     # Generate new migrations
make sh              # Shell into API container
```

**Production Services:**
- **Web UI (nginx):** http://localhost:8080
- **API:** http://localhost:4242
- **Mailhog:** http://localhost:8025

## 📡 API Routes

All API routes are prefixed with `/api/v1`:

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/v1/health` | Health check | Public |
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

### Backend (backend/.env)

Copy `backend/.env.example` to `backend/.env` and configure:

```env
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server
PORT=4242

# CORS (for Docker hot reload dev mode)
FRONTEND_ORIGIN=http://localhost:5174,http://localhost:4242

# Database (use 'db' for Docker, 'localhost' for local dev)
DATABASE_URL=postgresql://postgres:postgres@db:5432/stripe_portal

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@yourdomain.com

# Optional
ENABLE_SWAGGER=true
```

### Frontend (front/.env)

Copy `front/.env.example` to `front/.env`:

```env
# For Docker hot reload dev mode
VITE_API_URL=http://localhost:4242/api/v1

# For Docker production (nginx proxy)
# VITE_API_URL=/api/v1
```

**See `.env.example` files for complete documentation.**

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
