FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

# Cache buster - Coolify should pass COMMIT_SHA as build arg
ARG COMMIT_SHA=unknown
ENV COMMIT_SHA=$COMMIT_SHA

COPY . .

ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:1.27-alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
