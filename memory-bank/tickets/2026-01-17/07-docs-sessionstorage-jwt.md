# Ticket: Document sessionStorage JWT trade-offs

**Created:** 2026-01-17
**Priority:** P3
**Area:** Docs

## Summary

Document the security trade-offs of storing admin JWTs in `sessionStorage` and list alternatives.

## Context

- `front/src/pages/AdminLogin.jsx:258` stores JWT in `sessionStorage`

## Tasks

- [ ] Add documentation describing pros/cons of `sessionStorage`
- [ ] Note alternatives (httpOnly cookies + CSRF tokens)
- [ ] Mention why current choice was made

## Acceptance Criteria

- [ ] Documentation clearly explains the trade-off
- [ ] Alternatives are documented
