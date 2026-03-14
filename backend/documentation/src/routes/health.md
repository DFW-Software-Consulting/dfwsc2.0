# src/routes/health.ts

## Purpose
Provides a simple health check endpoint for container orchestration, load balancers, and monitoring systems.

## Dependencies
None (pure Fastify route)

## Environment Variables
None required.

## Routes

### GET `/api/v1/health`
Returns a simple health status response.

**Authentication**: None (public endpoint)

**Rate Limiting**: None

**Success Response** (200 OK):
```json
{
  "status": "ok"
}
```

**Use Cases**:
- Docker Compose health checks
- Kubernetes liveness/readiness probes
- Load balancer health checks
- Uptime monitoring

**Example Docker Compose Health Check**:
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:4242/api/v1/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 10s
```

**Example Kubernetes Probe**:
```yaml
livenessProbe:
  httpGet:
    path: /api/v1/health
    port: 4242
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /api/v1/health
    port: 4242
  initialDelaySeconds: 5
  periodSeconds: 10
```

---

## Testing & Debugging Notes

### Basic Health Check
```bash
curl http://localhost:4242/api/v1/health
# Expected: {"status":"ok"}
```

### Docker Health Check
```bash
docker compose ps
# Look for "(healthy)" status next to API container
```

### Container Logs
```bash
docker compose logs api
# Check for any startup errors before health check passes
```

### Common Issues

**Health check fails but server is running**
- Verify server is listening on correct port (default: 4242)
- Check that no firewall is blocking localhost access
- Ensure container network is properly configured

**Intermittent health check failures**
- May indicate database connection issues
- Check Stripe API connectivity
- Review application logs for errors

**Health check timeout**
- Increase timeout in Docker/Kubernetes configuration
- Check for slow database queries or external API calls blocking startup

---

## Notes

- This endpoint intentionally does NOT check database or external service connectivity
- For deep health checks, implement a separate `/api/v1/health/deep` endpoint if needed
- Response is always 200 OK with `{"status":"ok"}` when server is running
- No authentication or rate limiting to ensure monitoring systems can always access
