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

- [ ] Choose a secure hashing approach suitable for API keys
- [ ] Update API key creation to store hashed values
- [ ] Update API key validation to compare against hashes
- [ ] Plan data migration for existing keys
- [ ] Update documentation to reflect storage change

## Acceptance Criteria

- [ ] API keys are stored as hashes in the database
- [ ] Authentication validates using hashes
- [ ] Existing keys remain usable or have a clear migration plan
