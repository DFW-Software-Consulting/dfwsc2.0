# Ticket: Replace scattered console.error calls

**Created:** 2026-01-17
**Priority:** P3
**Area:** Frontend

## Summary

Replace direct `console.error` usage with a consistent logging utility for production readiness.

## Context

- Console errors are scattered across frontend components

## Tasks

- [x] Add or select a small logging utility for the frontend
- [x] Replace `console.error` usage with the utility
- [x] Keep developer-friendly logging in dev builds

## Acceptance Criteria

- [x] Console error calls are routed through a utility
- [x] Errors remain visible during development
