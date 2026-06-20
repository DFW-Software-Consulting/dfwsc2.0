FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:alpine AS production
COPY --from=builder /app/build-dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Run nginx as the non-root 'nginx' user. Make the paths nginx must write to
# (static root, conf, and the cache/temp dirs) owned by that user and relocate
# the pid file to a writable path. Without this the container crash-loops with
# EACCES on /var/cache/nginx/client_temp and /run/nginx.pid, leaving Traefik
# with no healthy backend (the site then returns a 404).
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d /var/cache/nginx \
    && sed -i 's#pid .*nginx\.pid;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf

USER nginx

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
