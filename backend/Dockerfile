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

FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
RUN npm ci --omit=dev && chown -R appuser:appgroup /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle ./drizzle

RUN mkdir -p /app/public && chown -R appuser:appgroup /app/public

RUN apk add --no-cache curl

USER appuser
CMD ["npm", "run", "start"]

FROM node:20-alpine AS development
ENV NODE_ENV=development
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
RUN npm ci && chown -R appuser:appgroup /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle ./drizzle

RUN mkdir -p /app/public && chown -R appuser:appgroup /app/public

RUN apk add --no-cache curl

USER appuser
CMD ["npm", "run", "start"]
