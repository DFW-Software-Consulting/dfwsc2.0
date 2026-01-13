# ------------------------------------------------------------
# Base image (shared by all stages)
# ------------------------------------------------------------
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

# ------------------------------------------------------------
# Stage 1: Build frontend (React)
# ------------------------------------------------------------
FROM base AS client-builder
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client ./client
RUN cd client && npm run build

# ------------------------------------------------------------
# Stage 2: Build backend (TypeScript)
# ------------------------------------------------------------
FROM base AS server-builder
ENV NODE_ENV=development

# Install all dependencies including dev deps (TypeScript + Drizzle)
RUN npm ci

# Copy TypeScript configs, Drizzle config, and app source
COPY tsconfig*.json ./
COPY drizzle.config.ts ./drizzle.config.ts
COPY src ./src
COPY drizzle ./drizzle

# Build TypeScript -> dist
RUN npm run build:server

# ------------------------------------------------------------
# Production runtime (minimal image)
# ------------------------------------------------------------
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy only production deps
COPY package*.json ./
RUN npm ci --omit=dev && chown -R appuser:appgroup /app

# Bring in compiled app and migrations/config
COPY --from=server-builder /app/dist ./dist
COPY --from=server-builder /app/drizzle ./drizzle
COPY --from=server-builder /app/drizzle.config.ts ./drizzle.config.ts

# Copy built frontend from client-builder
COPY --from=client-builder /app/public ./public

RUN apk add --no-cache curl

USER appuser
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD curl -fsS http://localhost:4242/api/v1/health || exit 1

CMD ["npm", "run", "start"]
