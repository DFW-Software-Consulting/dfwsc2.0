# Makefile Cheatsheet

## Dev
- `make build` — build dev images
- `make up` — start dev stack
- `make down` — stop dev stack
- `make logs` — follow app logs
- `make sh` — shell into app container

## Testing & Quality
- `make test` — run tests
- `make lint` — lint
- `make format` — format

## Database
- `make migrate`
- `make generate`
- `make seed`

## Webhooks
- `make webhook` — watch Stripe webhook logs from stripe-cli
- (Optional) `make ngrok-url` — print public URL if using ngrok overlay

## Prod
- `make up-prod` / `make down-prod`
- `make logs-prod`

## Cleanup
- `make prune` — docker system prune
