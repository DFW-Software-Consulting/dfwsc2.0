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
 
# Copy template and use envsubst at runtime
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
RUN chmod +x /etc/nginx/templates/nginx.conf.template
 
# Replace env vars and start nginx
CMD sh -c "envsubst < /etc/nginx/templates/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"
