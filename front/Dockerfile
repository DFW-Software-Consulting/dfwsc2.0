FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api/v1
ARG VITE_ANALYTICS_SRC=
ARG VITE_ANALYTICS_DOMAIN=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_ANALYTICS_SRC=$VITE_ANALYTICS_SRC
ENV VITE_ANALYTICS_DOMAIN=$VITE_ANALYTICS_DOMAIN

RUN npm run build

# The analytics script and its Plausible-compatible event endpoint share an
# origin. Derive that exact origin at build time so CSP permits only the
# configured service (and remains restrictive when analytics is disabled).
RUN ANALYTICS_ORIGIN="$(node -e 'const source = process.env.VITE_ANALYTICS_SRC; if (!source) process.exit(0); const url = new URL(source); if (!/^https?:$/.test(url.protocol)) throw new Error("VITE_ANALYTICS_SRC must use http or https"); process.stdout.write(url.origin);')" \
    && sed "s|__ANALYTICS_ORIGIN__|${ANALYTICS_ORIGIN}|g" nginx.conf > nginx.production.conf \
    && ! grep -q '__ANALYTICS_ORIGIN__' nginx.production.conf

FROM nginx:alpine AS production
COPY --from=builder /app/build-dist /usr/share/nginx/html
COPY --from=builder /app/nginx.production.conf /etc/nginx/conf.d/default.conf

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
