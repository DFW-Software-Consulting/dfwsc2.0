FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Install serve package for static file serving
RUN npm install -g serve

# Serve static files on port 3000
EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
