SHELL := /bin/bash
COMPOSE := docker compose -f docker-compose.base.yml -f docker-compose.dev.yml
PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: help up up-build down down-v logs ps sh dev-frontend dev-backend test test-front test-back test-up coverage prod prod-build down-prod logs-prod sh-prod ps-prod backup-build backup-shell backup-now backup-list backup-restore

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
	@echo "  make test         # Run all tests (frontend local + backend in container)"
	@echo "  make test-front   # Run frontend tests locally"
	@echo "  make test-back    # Run backend tests inside dev container"
	@echo "  make test-up      # Start dev stack and run all tests"
	@echo "  make coverage     # Run backend tests with coverage report"
	@echo "  make prod         # Start prod stack (api, migrator)"
	@echo "  make prod-build   # Build + start prod stack"
	@echo "  make down-prod    # Stop prod stack"
	@echo "  make logs-prod    # Tail prod api logs"
	@echo "  make sh-prod      # Shell into prod api container"
	@echo "  make ps-prod      # Show prod containers"
	@echo "  make backup-build # Build the production backup image"
	@echo "  make backup-shell # Open a shell in the backup container"
	@echo "  make backup-now   # Run one backup immediately"
	@echo "  make backup-list  # List local backup files"
	@echo "  make backup-restore FILE=... [RESTORE_CONFIRM=yes] # Restore a backup"

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

# Run all tests: frontend locally + backend inside Docker container
test: test-front test-back

test-front:
	npm run test --prefix front

# Run backend tests using DATABASE_URL the API service gets from Docker Compose
test-back:
	$(COMPOSE) exec api npm test

coverage:
	$(COMPOSE) exec api npm run test:coverage

test-up:
	$(COMPOSE) up -d
	$(COMPOSE) exec api sh -c "until [ -f node_modules/.bin/vitest ]; do sleep 1; done && npm test"
	npm run test --prefix front

prod:
	$(PROD_COMPOSE) up -d

prod-build:
	$(PROD_COMPOSE) up -d --build

down-prod:
	docker compose -f docker-compose.prod.yml down

logs-prod:
	docker compose -f docker-compose.prod.yml logs -f api

sh-prod:
	docker compose -f docker-compose.prod.yml exec api sh

ps-prod:
	docker compose -f docker-compose.prod.yml ps

# Backup image helpers
backup-build:
	$(PROD_COMPOSE) build backup

backup-shell:
	$(PROD_COMPOSE) run --rm --entrypoint /bin/sh backup

backup-now:
	$(PROD_COMPOSE) run --rm --entrypoint /usr/local/bin/backup.sh backup

backup-list:
	$(PROD_COMPOSE) run --rm --entrypoint /bin/sh backup -c 'ls -lht /backups/postgres/*.sql.gz 2>/dev/null || echo "No local backups"'

backup-restore:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make backup-restore FILE=/backups/postgres/YYYYmmdd_HHMMSS_<db>.sql.gz [RESTORE_CONFIRM=yes] [RESTORE_NONINTERACTIVE=1]"; \
		exit 1; \
	fi
	RESTORE_CONFIRM=$(RESTORE_CONFIRM) RESTORE_NONINTERACTIVE=$(RESTORE_NONINTERACTIVE) \
		$(PROD_COMPOSE) run --rm --entrypoint /usr/local/bin/restore.sh backup "$(FILE)"
