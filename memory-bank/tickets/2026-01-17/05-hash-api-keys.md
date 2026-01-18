# Ticket: Hash API keys at rest

**Created:** 2026-01-17
**Priority:** P2
**Area:** Backend

## Summary

Store API keys as hashes instead of plaintext to reduce risk if the database is exposed.

## Context

- `backend/src/routes/connect.ts` around line 1043
- Comment in `backend/src/lib/auth.ts:199` notes plaintext storage

## Tasks

- [x] Choose a secure hashing approach suitable for API keys
- [x] Update API key creation to store hashed values
- [x] Update API key validation to compare against hashes
- [x] Plan data migration for existing keys
- [x] Update documentation to reflect storage change

## Acceptance Criteria

- [x] API keys are stored as hashes in the database
- [x] Authentication validates using hashes
- [x] Existing keys remain usable or have a clear migration plan
