# Docker Cheatsheet

## Dev stack
- Start: `docker compose -f docker-compose.yml up -d` or `make up`
- Logs: `make logs`
- Stop: `make down`

## Prod stack
- Start: `docker compose -f docker-compose.prod.yml up -d` or `make up-prod`
- Logs: `make logs-prod`
- Stop: `make down-prod`

## Using ngrok (optional)
- Start with overlay: `docker compose -f docker-compose.yml -f docker-compose.ngrok.yml up -d`
- Print URL: `make ngrok-url`

## Using stripe-cli in dev
- Already included as a service; it forwards events to `/webhooks/stripe`.
- View events: `make webhook`
