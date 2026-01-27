# 2026-01-27 Security Hardening

## Summary
Non-blocking security hardening improvements identified during security review of the admin/onboard route split PR. These are defense-in-depth measures, not vulnerabilities.

## Priority
Low - Code quality improvements for future hardening

## Tasks

### 1. Improve Email Validation
**File:** `backend/src/routes/connect.ts:123-125`

**Current:**
```typescript
if (!email || typeof email !== 'string' || !email.includes('@')) {
  throw Object.assign(new Error('Valid email is required'), { statusCode: 400 });
}
```

**Issue:** Minimal validation only checks for `@` character presence.

**Recommendation:** Use a proper email validation library (e.g., `validator.js` or `email-validator`) for RFC-compliant email validation.

---

### 2. Enforce Hashed Passwords in Production
**File:** `backend/src/routes/auth.ts:48-52`

**Current:** Code correctly warns about plaintext passwords and supports bcrypt hashing.

**Issue:** No runtime enforcement that production uses hashed passwords.

**Recommendations:**
- Add a startup check that rejects plaintext `ADMIN_PASSWORD` when `NODE_ENV=production`
- Update deployment docs to require bcrypt-hashed passwords
- Consider removing plaintext password support entirely in a future release

---

### 3. HTML Escape User Input in Email Templates
**File:** `backend/src/routes/connect.ts:206-212`

**Current:**
```typescript
const mailHtml = `
  <h1>Welcome to DFW Software Consulting</h1>
  <p>Hi ${name},</p>
  ...
`;
```

**Issue:** User-provided `name` is interpolated directly into HTML without escaping.

**Context:** Low risk since input comes from authenticated admin, but defense-in-depth is recommended.

**Recommendation:** Use an HTML escaping utility before interpolating user values:
```typescript
import { escape } from 'lodash'; // or a lightweight alternative

const mailHtml = `
  <p>Hi ${escape(name)},</p>
`;
```

## Acceptance Criteria
- [ ] Email validation uses RFC-compliant library
- [ ] Production startup fails if `ADMIN_PASSWORD` is not bcrypt-hashed
- [ ] Email templates escape user-provided values

## Notes
- All items are non-blocking improvements
- Identified during security review - no exploitable vulnerabilities found
- Implement as time permits or bundle with related backend work
