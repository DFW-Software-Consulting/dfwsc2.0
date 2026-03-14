# src/routes/clients.ts

## Purpose
Manages client records including listing, updating status, and configuring client-specific settings (payment URLs, processing fees, group associations).

## Dependencies
- Drizzle ORM for database operations
- `src/lib/auth.ts` - `requireAdminJwt` middleware
- Database tables: `clients`, `clientGroups`

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | ✅ | Required for JWT verification |

## Routes

### GET `/api/v1/clients`
Retrieves a list of all clients with optional filtering by group.

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `groupId` | string (optional) | Filter clients by group ID |

**Success Response** (200 OK):
```json
[
  {
    "id": "client_abc123",
    "name": "Acme Corporation",
    "email": "billing@acme.com",
    "stripeAccountId": "acct_1234567890",
    "status": "active",
    "groupId": "group_xyz",
    "processingFeePercent": "2.50",
    "processingFeeCents": 100,
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
]
```

**Error Responses**:
- `401 Unauthorized`: Missing or invalid JWT token
- `500 Internal Server Error`: Database query failure

---

### PATCH `/api/v1/clients/:id`
Updates a client record. Supports partial updates for any field.

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**URL Parameters**:
- `id` (string, required): Client ID to update

**Request Body** (all fields optional):
```json
{
  "status": "active" | "inactive",
  "groupId": "group_xyz" | null,
  "paymentSuccessUrl": "https://example.com/success" | null,
  "paymentCancelUrl": "https://example.com/cancel" | null,
  "processingFeePercent": 2.50 | null,
  "processingFeeCents": 100 | null
}
```

**Field Constraints**:
| Field | Constraints |
|-------|-------------|
| `status` | Must be `"active"` or `"inactive"` |
| `groupId` | Must reference an existing group ID |
| `paymentSuccessUrl` | Must be a valid HTTPS URL |
| `paymentCancelUrl` | Must be a valid HTTPS URL |
| `processingFeePercent` | Must be > 0 and ≤ 100; cannot be set with `processingFeeCents` |
| `processingFeeCents` | Must be a non-negative integer; cannot be set with `processingFeePercent` |

**Success Response** (200 OK):
```json
{
  "id": "client_abc123",
  "name": "Acme Corporation",
  "email": "billing@acme.com",
  "stripeAccountId": "acct_1234567890",
  "status": "inactive",
  "groupId": "group_xyz",
  "paymentSuccessUrl": "https://example.com/success",
  "paymentCancelUrl": "https://example.com/cancel",
  "processingFeePercent": "2.50",
  "processingFeeCents": 100,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-03-10T16:20:00.000Z"
}
```

**Error Responses**:
- `400 Bad Request`: Invalid field value (see constraints above)
- `401 Unauthorized**: Missing or invalid JWT token
- `404 Not Found**: Client ID does not exist
- `500 Internal Server Error**: Database update failure

**Notes**:
- Setting `status` to `"inactive"` soft-deletes the client (does not remove from database)
- `updatedAt` timestamp is automatically set on any update
- Null values clear the field (useful for reverting to group defaults)
- Client remains visible in list regardless of status

---

## Testing & Debugging Notes

### List All Clients
```bash
curl http://localhost:4242/api/v1/clients \
  -H "Authorization: Bearer <jwt_token>"
```

### Filter by Group
```bash
curl "http://localhost:4242/api/v1/clients?groupId=group_xyz" \
  -H "Authorization: Bearer <jwt_token>"
```

### Update Client Status (Soft Delete)
```bash
curl -X PATCH http://localhost:4242/api/v1/clients/client_abc123 \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"inactive"}'
```

### Set Custom Payment URLs
```bash
curl -X PATCH http://localhost:4242/api/v1/clients/client_abc123 \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentSuccessUrl": "https://client.com/success",
    "paymentCancelUrl": "https://client.com/cancel"
  }'
```

### Common Issues

**"Group not found"**
- The `groupId` provided does not exist in the `clientGroups` table
- Fix: Create the group first via `POST /api/v1/groups`

**"Invalid status value"**
- Status must be exactly `"active"` or `"inactive"` (case-sensitive)

**"Set one fee type, not both"**
- Cannot set both `processingFeePercent` and `processingFeeCents` simultaneously
- Choose either percentage-based or fixed-fee pricing

**HTTPS URL validation fails**
- URLs must start with `https://`
- HTTP URLs are rejected for security
