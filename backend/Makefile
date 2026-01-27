SHELL := /bin/bash
PROJECT := stripe_payment_portal
DOCKER := docker
COMPOSE := docker compose

# Compose files
DEV_FILES := -f docker-compose.yml
PROD_FILES := -f docker-compose.prod.yml
NGROK_FILES := -f docker-compose.ngrok.yml

# Env files
ENV_PROD := --env-file .env.prod

# Default
.PHONY: help
help:
	@echo "Common targets:"
	@echo "  make build            # Build dev images"
	@echo "  make up               # Start dev stack (app, db, mailhog, stripe-cli)"
	@echo "  make down             # Stop dev stack"
	@echo "  make logs             # Tail dev app logs"
	@echo "  make sh               # Shell into dev app container"
	@echo "  make test             # Run tests"
	@echo "  make lint             # Lint"
	@echo "  make format           # Format"
	@echo "  make migrate          # DB migrations (dev)"
	@echo "  make generate         # DB generate (dev)"
	@echo "  make seed             # DB seed (dev)"
	@echo "  make webhook          # Stripe CLI logs (dev)"
	@echo "  make ngrok-url        # Print ngrok https URL (if using ngrok overlay)"
	@echo "  make up-prod          # Start prod stack (uses .env.prod)"
	@echo "  make rebuild-prod     # Rebuild + start prod stack"
	@echo "  make down-prod        # Stop prod stack"
	@echo "  make logs-prod        # Tail prod app logs"
	@echo "  make logs-migrator    # Tail prod migrator logs"
	@echo "  make ps-prod          # Show prod containers"
	@echo "  make sh-prod          # Shell into prod app container"
	@echo "  make exec-prod        # Exec arbitrary command in prod app container (CMD='<cmd>')"
	@echo "  make prune            # Docker prune"

# ------------------------------
# Build & run (dev)
# ------------------------------
.PHONY: build
build:
	$(COMPOSE) $(DEV_FILES) build

.PHONY: up
up:
	$(COMPOSE) $(DEV_FILES) up -d

.PHONY: down
down:
	$(COMPOSE) $(DEV_FILES) down

.PHONY: logs
logs:
	$(COMPOSE) $(DEV_FILES) logs -f app

.PHONY: sh
sh:
	$(COMPOSE) $(DEV_FILES) exec app sh

# Tests / lint / format
.PHONY: test
test:
	$(COMPOSE) $(DEV_FILES) exec app npm test -- --watch=false || true

.PHONY: test-stripe
test-stripe:
	@./test-stripe-events.sh

.PHONY: lint
lint:
	$(COMPOSE) $(DEV_FILES) exec app npm run lint || true

.PHONY: format
format:
	$(COMPOSE) $(DEV_FILES) exec app npm run format || true

# Database (dev)
.PHONY: migrate
migrate:
	$(COMPOSE) $(DEV_FILES) exec app npm run db:migrate

.PHONY: generate
generate:
	$(COMPOSE) $(DEV_FILES) exec app npm run db:generate

.PHONY: seed
seed:
	$(COMPOSE) $(DEV_FILES) exec app npm run db:seed

# Stripe CLI (dev)
.PHONY: webhook
webhook:
	$(COMPOSE) $(DEV_FILES) logs -f stripe-cli

# ngrok helper (dev)
.PHONY: ngrok-url
ngrok-url:
	@$(DOCKER) compose $(DEV_FILES) $(NGROK_FILES) exec ngrok sh -lc "curl -s http://127.0.0.1:4040/api/tunnels | sed -nE 's/.*\"public_url\":\"(https:[^\"]+)\".*/\1/p' | head -n1"

# ------------------------------
# Production
# ------------------------------
.PHONY: up-prod
up-prod:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) up -d

.PHONY: rebuild-prod
rebuild-prod:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) up --build -d

.PHONY: down-prod
down-prod:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) down

.PHONY: logs-prod
logs-prod:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) logs -f app

.PHONY: logs-migrator
logs-migrator:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) logs -f migrator

.PHONY: ps-prod
ps-prod:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) ps

.PHONY: sh-prod
sh-prod:
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) exec app sh

# Usage: make exec-prod CMD="node -e 'console.log(process.env.PORT)'"
.PHONY: exec-prod
exec-prod:
	@if [ -z "$(CMD)" ]; then echo "Usage: make exec-prod CMD='<command>'"; exit 1; fi
	$(COMPOSE) $(ENV_PROD) $(PROD_FILES) exec app sh -lc "$(CMD)"

# ------------------------------
# Cleanup
# ------------------------------
.PHONY: prune
prune:
	$(DOCKER) system prune -f
