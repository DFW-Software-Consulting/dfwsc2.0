# Contributing

Thank you for contributing to DFWSC Stripe Payment Portal.

## Workflow
1. Create a feature branch from `main`.
2. Make focused changes with clear commits.
3. Run tests and update docs as needed.
4. Open a pull request with a clear summary and testing notes.

## Code Style
- Follow existing TypeScript/React patterns in the repo.
- Prefer small, readable functions with descriptive names.
- Update documentation when behavior, env vars, or flows change.

## Testing Expectations
- Backend: `npm run test` (or `make test` in Docker).
- Frontend: `cd front && npm test`.
- If manual checks are required, record them in `manual_checks.md`.

## Pull Request Checklist
- [ ] Tests pass locally or in Docker.
- [ ] Docs updated (README or `backend/documentation/`).
- [ ] No secrets committed.
- [ ] Added migration steps if schema changed.
