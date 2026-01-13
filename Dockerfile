# ------------------------------------------------------------
# Base image (shared by all stages)
# ------------------------------------------------------------
FROM node:20-alpine AS base
WORKDIR /app

# ------------------------------------------------------------
# Stage 1: Build frontend (React)
# ------------------------------------------------------------
FROM base AS frontend-builder
COPY front/package*.json ./front/
RUN cd front && npm ci
COPY front ./front
RUN cd front && npm run build

# ------------------------------------------------------------
# Stage 2: Build backend (TypeScript)
# ------------------------------------------------------------
FROM base AS backend-builder
ENV NODE_ENV=development

COPY backend/package*.json ./backend/
RUN cd backend && npm ci

# Copy TypeScript configs, Drizzle config, and app source
COPY backend/tsconfig*.json ./backend/
COPY backend/drizzle.config.ts ./backend/
COPY backend/src ./backend/src

# Build TypeScript -> dist
RUN cd backend && npm run build:server

# ------------------------------------------------------------
# Stage 3: Production runtime (minimal image)
# ------------------------------------------------------------
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy backend package files and install production deps
COPY backend/package*.json ./
RUN npm ci --omit=dev && chown -R appuser:appgroup /app

# Bring in compiled backend and migrations/config
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=backend-builder /app/backend/drizzle.config.ts ./drizzle.config.ts

# Copy built frontend from frontend-builder
COPY --from=frontend-builder /app/backend/public ./public

# Install curl for health checks
RUN apk add --no-cache curl

USER appuser
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD curl -fsS http://localhost:4242/api/v1/health || exit 1

CMD ["npm", "run", "start"]
