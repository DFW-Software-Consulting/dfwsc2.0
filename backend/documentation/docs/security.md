# Security Considerations

## Admin JWT Storage

### Current Approach
- JWTs stored in `sessionStorage` (see `AdminLogin.jsx:61`)

### Critical Security Warning
**Storing JWTs in `sessionStorage` creates a significant security vulnerability if any XSS (Cross-Site Scripting) occurs.** Any JavaScript running on the page can access tokens stored in `sessionStorage`, making them immediately compromised in an XSS attack. This approach should be avoided whenever possible.

### sessionStorage Trade-offs

**Pros:**
- Automatic cleanup on tab/window close
- Not sent with every HTTP request (unlike cookies)
- Simple implementation
- Scoped to single tab (isolation)

**Cons:**
- **CRITICAL SECURITY RISK**: Vulnerable to XSS attacks (JavaScript accessible)
- Not shared across tabs
- Lost on page refresh (if not persisted elsewhere)

### Recommended Alternatives (Preferred)

#### httpOnly Cookies + CSRF Tokens (Most Secure)
- Pros: Immune to XSS, automatically sent with requests
- Cons: Requires CSRF protection, more complex implementation

#### In-Memory (React State/Context) (Good Alternative)
- Pros: Most secure (no storage access), prevents XSS token theft
- Cons: Lost on refresh, requires re-authentication

#### localStorage (Less Secure)
- Pros: Persists across sessions, shared across tabs
- Cons: XSS vulnerable, never auto-clears

### Rationale for Current Choice (Legacy/Temporary)
- Admin portal is internal-facing with controlled access (though this does not eliminate XSS risk)
- **WARNING**: This implementation should be considered temporary or legacy
- sessionStorage provides automatic cleanup which reduces token exposure window
- Simple implementation appropriate for current scope but not recommended for future development
- **Strongly recommend migrating to httpOnly cookies + CSRF tokens for improved security**

### Security Best Practices
- Implement Content Security Policy (CSP) to mitigate XSS risks
- Regular security audits to identify potential XSS vulnerabilities
- Consider migrating to httpOnly cookies as soon as possible
- Minimize the scope and privileges of stored JWTs

## Additional Controls

### Headers & CSP
- Set a CSP that restricts script sources to trusted domains.
- Enable `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
- Ensure `FRONTEND_ORIGIN` matches allowed CORS origins.

### Rate Limiting
- `/api/v1/auth/login` is rate limited; keep limits aligned with threat modeling.
- Consider adding per-IP limits for onboarding and payment creation endpoints.

### Secret Handling
- Store secrets in a managed vault (1Password, Vault, or cloud secret manager).
- Rotate Stripe keys and JWT secrets on a regular cadence.
- Never log secrets; mask values in startup logs.
