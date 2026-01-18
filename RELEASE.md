# Release Process

Use this checklist to ship a release safely.

## 1. Prep
- Confirm `main` is green and docs are up to date.
- Review open issues for blockers.
- Decide on a version number or release tag.

## 2. Build & Test
- Run backend tests: `npm run test` (or `make test`).
- Run frontend tests: `cd front && npm test`.
- Build artifacts: `npm run build`.

## 3. Deploy
- Update `.env.prod` values if needed.
- Build and start containers: `docker-compose -f docker-compose.prod.yml up --build -d`.
- Verify `/api/v1/health` responds OK.
- Confirm onboarding, payment, and webhook flows in Stripe test mode.

## 4. Post-Deploy
- Monitor logs and webhook delivery.
- Record the release notes in `backend/documentation/CHANGELOG.md`.
- Notify stakeholders and track any follow-ups.
