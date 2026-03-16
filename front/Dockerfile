FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:alpine AS production

# Copy built files from builder (using new output directory)
COPY --from=builder /app/build-dist /usr/share/nginx/html

# Expose standard HTTP/HTTPS ports
EXPOSE 80 443

# Use nginx to serve static files
CMD ["nginx", "-g", "daemon off;"]
