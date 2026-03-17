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

FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build-dist ./dist
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle ./drizzle

USER node

CMD ["sh", "-c", "npx drizzle-kit migrate && npm run start"]
