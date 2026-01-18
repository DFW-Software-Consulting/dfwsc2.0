# Ticket: Document sessionStorage JWT trade-offs

**Created:** 2026-01-17
**Priority:** P3
**Area:** Docs

## Summary

Document the security trade-offs of storing admin JWTs in `sessionStorage` and list alternatives.

## Context

- `front/src/pages/AdminLogin.jsx:258` stores JWT in `sessionStorage`

## Tasks

- [x] Add documentation describing pros/cons of `sessionStorage`
- [x] Note alternatives (httpOnly cookies + CSRF tokens)
- [x] Mention why current choice was made

## Acceptance Criteria

- [x] Documentation clearly explains the trade-off
- [x] Alternatives are documented
