SHELL := /bin/bash
COMPOSE := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: help up up-build down down-v logs ps sh dev-frontend dev-backend test test-up prod prod-build

help:
	@echo "Common targets:"
	@echo "  make up           # Start dev stack (api, web, db, mailhog, stripe-cli)"
	@echo "  make up-build     # Build + start dev stack"
	@echo "  make down         # Stop dev stack"
	@echo "  make down-v       # Stop dev stack and remove volumes"
	@echo "  make logs         # Tail app logs"
	@echo "  make ps           # Show containers"
	@echo "  make sh           # Shell into app container"
	@echo "  make dev-frontend # Run React dev server (port 5173)"
	@echo "  make dev-backend  # Run API dev server (port 4242)"
	@echo "  make test         # Run backend tests inside dev container"
	@echo "  make test-up      # Start dev stack and run tests inside API container"
	@echo "  make prod         # Start prod stack (api, web, db, mailhog, stripe-cli)"
	@echo "  make prod-build   # Build + start prod stack"

up:
	$(COMPOSE) up -d

up-build:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

down-v:
	$(COMPOSE) down -v

logs:
	$(COMPOSE) logs -f api

ps:
	$(COMPOSE) ps

sh:
	$(COMPOSE) exec api sh

dev-frontend:
	npm run dev:frontend

dev-backend:
	npm run dev:backend

# Run tests using whatever DATABASE_URL the API service already gets from Docker Compose.
test:
	$(COMPOSE) exec api npm test

test-up:
	$(COMPOSE) up -d
	$(COMPOSE) exec api npm test

prod:
	docker compose -f docker-compose.prod.yml up -d

prod-build:
	docker compose -f docker-compose.prod.yml up -d --build
