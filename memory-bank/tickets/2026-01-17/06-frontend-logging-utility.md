# Ticket: Replace scattered console.error calls

**Created:** 2026-01-17
**Priority:** P3
**Area:** Frontend

## Summary

Replace direct `console.error` usage with a consistent logging utility for production readiness.

## Context

- Console errors are scattered across frontend components

## Tasks

- [ ] Add or select a small logging utility for the frontend
- [ ] Replace `console.error` usage with the utility
- [ ] Keep developer-friendly logging in dev builds

## Acceptance Criteria

- [ ] Console error calls are routed through a utility
- [ ] Errors remain visible during development
