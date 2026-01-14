SHELL := /bin/bash
COMPOSE := docker compose -f docker-compose.yml
COMPOSE_DEV := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: help up up-build down down-v logs ps sh dev-frontend dev-backend setup install migrate db-generate dev-up dev-up-build dev-down dev-logs

help:
	@echo "Common targets:"
	@echo "  make setup         # Full setup (install deps + generate migrations)"
	@echo "  make install       # Install all dependencies"
	@echo ""
	@echo "Docker - Production Mode:"
	@echo "  make up            # Start production stack"
	@echo "  make up-build      # Build + start production stack"
	@echo "  make down          # Stop stack"
	@echo "  make down-v        # Stop stack and remove volumes"
	@echo "  make logs          # Tail API logs"
	@echo "  make ps            # Show containers"
	@echo ""
	@echo "Docker - Development Mode (Hot Reload):"
	@echo "  make dev-up        # Start dev stack with hot reload"
	@echo "  make dev-up-build  # Build + start dev stack with hot reload"
	@echo "  make dev-down      # Stop dev stack"
	@echo "  make dev-logs      # Tail dev API logs"
	@echo ""
	@echo "Local Development:"
	@echo "  make dev-frontend  # Run React dev server locally (port 5173)"
	@echo "  make dev-backend   # Run API dev server locally (port 4242)"
	@echo ""
	@echo "Database:"
	@echo "  make migrate       # Run database migrations"
	@echo "  make db-generate   # Generate new migrations"
	@echo "  make sh            # Shell into API container"

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
	$(COMPOSE) exec app sh

dev-frontend:
	npm run dev:frontend

dev-backend:
	npm run dev:backend

setup:
	@echo "Installing dependencies..."
	npm run install:all
	@echo "Generating database migrations..."
	DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stripe_portal npm run db:generate
	@echo "Setup complete! Run 'make up-build' to start the app."

install:
	npm run install:all

migrate:
	@echo "Running database migrations..."
	DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stripe_portal npm run db:migrate
	@echo "Migrations complete! Restarting API container..."
	$(COMPOSE) restart api

db-generate:
	DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stripe_portal npm run db:generate

dev-up:
	$(COMPOSE_DEV) up -d

dev-up-build:
	$(COMPOSE_DEV) up -d --build

dev-down:
	$(COMPOSE_DEV) down

dev-logs:
	$(COMPOSE_DEV) logs -f api
