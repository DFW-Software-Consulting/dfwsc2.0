# DFWSC Stripe Payment Portal — High-Level Overview

## Purpose
This app is a lightweight payment portal for DFW Software Consulting clients and also serves as the company’s public landing/marketing site. It focuses on Stripe Connect onboarding and payment creation, while keeping Stripe as the source of truth for all payment state.

## What It Does (High Level)
- Lets an admin create client records and issue onboarding tokens.
- Sends clients to Stripe Connect onboarding to set up their account.
- Creates payments on behalf of connected accounts (with platform fees).
- Receives and stores Stripe webhook events for audit/tracking.

## Main Actors
- **Admin**: Logs in, creates clients, sends onboarding links, and creates payments.
- **Client**: Uses an onboarding token to connect their Stripe account.
- **Stripe**: Handles onboarding, payments, and webhook events.

## Core Flows
1. **Admin login** → JWT issued for admin routes.
2. **Client onboarding** → Admin generates token → client opens `/onboard` → Stripe Connect onboarding → callback links Stripe account to client record.
3. **Payments** → Admin (or client) creates payment via API → Stripe processes payment → webhook events stored.

## What Lives in the Database
- Client records (name, email, Stripe account ID)
- Onboarding tokens and status
- Raw webhook events

## What Does *Not* Live Locally
- Payment state, refunds, invoices, ledgers
- These are handled directly by Stripe

## How It’s Structured
- **Frontend**: React app in `front/` (company landing/marketing site + onboarding/admin UI)
- **Backend**: Fastify API in `backend/`
- **Database**: PostgreSQL (minimal schema)
- **Containers**: Docker Compose for full local stack

## Local Run (Docker)
- `make up` to start the full dev stack
- Web UI: http://localhost:8080
- API: http://localhost:4242
- Mailhog: http://localhost:8025
