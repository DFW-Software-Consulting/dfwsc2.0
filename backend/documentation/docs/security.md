# Security Considerations

## Admin JWT Storage

### Current Approach
- JWTs stored in `sessionStorage` (see `AdminLogin.jsx:61`)

### sessionStorage Trade-offs

**Pros:**
- Automatic cleanup on tab/window close
- Not sent with every HTTP request (unlike cookies)
- Simple implementation
- Scoped to single tab (isolation)

**Cons:**
- Vulnerable to XSS attacks (JavaScript accessible)
- Not shared across tabs
- Lost on page refresh (if not persisted elsewhere)

### Alternatives

#### httpOnly Cookies + CSRF Tokens
- Pros: Immune to XSS, automatically sent with requests
- Cons: Requires CSRF protection, more complex implementation

#### localStorage
- Pros: Persists across sessions, shared across tabs
- Cons: XSS vulnerable, never auto-clears

#### In-Memory (React State/Context)
- Pros: Most secure (no storage access)
- Cons: Lost on refresh, requires re-authentication

### Rationale for Current Choice
- Admin portal is internal-facing with controlled access
- sessionStorage provides reasonable balance of security and UX
- Auto-cleanup on tab close reduces token exposure window
- Simple implementation appropriate for current scope