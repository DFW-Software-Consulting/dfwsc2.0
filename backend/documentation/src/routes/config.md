# src/routes/config.ts

## Purpose
Serves runtime configuration to the frontend as a JavaScript file, allowing environment variables to be injected into the client-side application without build-time embedding.

## Dependencies
None (pure Fastify route)

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `API_BASE_URL` | ✅ | Public API URL served to frontend |

## Routes

### GET `/api/v1/app-config.js`
Returns a JavaScript file that sets `window.API_URL` for frontend consumption.

**Authentication**: None (public endpoint)

**Rate Limiting**: None

**Response Content-Type**: `application/javascript`

**Response Body**:
```javascript
window.API_URL = "http://localhost:4242";
```

**Error Response** (500 Internal Server Error):
```json
{
  "error": "Internal Server Error: API_BASE_URL not configured"
}
```

---

## Usage in Frontend

### HTML Integration
Include in your HTML `<head>` before other scripts:
```html
<script src="/api/v1/app-config.js"></script>
<script>
  // Now window.API_URL is available
  const apiUrl = window.API_URL;
  fetch(`${apiUrl}/api/v1/health`)
    .then(res => res.json())
    .then(data => console.log(data));
</script>
```

### TypeScript Declaration
Add a declaration file (`src/types/window.d.ts`):
```ts
declare global {
  interface Window {
    API_URL: string;
  }
}

export {};
```

---

## Testing & Debugging Notes

### Fetch Config
```bash
curl http://localhost:4242/api/v1/app-config.js
# Expected: window.API_URL = "http://localhost:4242";
```

### Verify Content-Type
```bash
curl -I http://localhost:4242/api/v1/app-config.js
# Expected: Content-Type: application/javascript
```

### Common Issues

**"API_BASE_URL not configured"**
- Environment variable is not set
- Fix: Add `API_BASE_URL=http://localhost:4242` (or production URL) to `.env`

**XSS concerns with URL injection**
- The route uses `JSON.stringify()` for safe JavaScript string embedding
- This prevents injection attacks via malicious URL values
- Example: `http://evil.com";alert(1);//` becomes `"http://evil.com\";alert(1);//"`

**Config not loading in frontend**
- Ensure `<script src="/api/v1/app-config.js">` is loaded before scripts that use `window.API_URL`
- Check browser console for 404 errors
- Verify nginx/Docker proxy is routing `/api/v1/*` to backend

---

## Architecture Notes

### Why Runtime Config?
- Allows same frontend build to be deployed across environments (dev, staging, prod)
- No need to rebuild frontend for different API URLs
- Docker containers can be configured at runtime via environment variables

### Alternative Approaches
- **Build-time embedding**: Faster but requires rebuild per environment
- **JSON endpoint**: `/api/v1/config` returns `{ apiUrl: "..." }` but requires async fetch
- **Meta tags**: `<meta name="api-url" content="...">` but less convenient than `window` object

### Security Considerations
- Config endpoint is public (no auth) - do not expose secrets here
- Only non-sensitive configuration should be served
- `API_BASE_URL` is safe to expose as it's the public API endpoint
