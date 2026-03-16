# src/routes/groups.ts

## Purpose
Manages client groups for shared configuration across multiple clients (processing fees, payment URLs, status).

## Dependencies
- Drizzle ORM for database operations
- `nanoid` - Compact ID generation
- `src/lib/auth.ts` - `requireAdminJwt` middleware
- Database table: `clientGroups`

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | ✅ | Required for JWT verification |

## Routes

### POST `/api/v1/groups`
Creates a new client group.

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**Request Body**:
```json
{
  "name": "Enterprise Clients"
}
```

**Success Response** (201 Created):
```json
{
  "id": "grp_abc123",
  "name": "Enterprise Clients",
  "status": "active",
  "processingFeePercent": null,
  "processingFeeCents": null,
  "paymentSuccessUrl": null,
  "paymentCancelUrl": null,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses**:
- `400 Bad Request`: Missing or invalid name
- `401 Unauthorized**: Missing or invalid JWT token
- `500 Internal Server Error**: Database insertion failure

---

### GET `/api/v1/groups`
Retrieves all client groups.

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**Success Response** (200 OK):
```json
[
  {
    "id": "grp_abc123",
    "name": "Enterprise Clients",
    "status": "active",
    "processingFeePercent": "2.50",
    "processingFeeCents": 100,
    "paymentSuccessUrl": "https://example.com/success",
    "paymentCancelUrl": "https://example.com/cancel",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
]
```

**Error Responses**:
- `401 Unauthorized**: Missing or invalid JWT token
- `500 Internal Server Error**: Database query failure

---

### PATCH `/api/v1/groups/:id`
Updates a client group configuration.

**Authentication**: Required (JWT Bearer token with `role: admin`)

**Headers**:
```
Authorization: Bearer <jwt_token>
```

**URL Parameters**:
- `id` (string, required): Group ID to update

**Request Body** (all fields optional):
```json
{
  "name": "Updated Group Name",
  "status": "active" | "inactive",
  "processingFeePercent": 2.50 | null,
  "processingFeeCents": 100 | null,
  "paymentSuccessUrl": "https://example.com/success" | null,
  "paymentCancelUrl": "https://example.com/cancel" | null
}
```

**Field Constraints**:
| Field | Constraints |
|-------|-------------|
| `name` | Must be a non-empty string |
| `status` | Must be `"active"` or `"inactive"` |
| `processingFeePercent` | Must be > 0 and ≤ 100; cannot be set with `processingFeeCents` |
| `processingFeeCents` | Must be a non-negative integer; cannot be set with `processingFeePercent` |
| `paymentSuccessUrl` | Must be a valid HTTPS URL |
| `paymentCancelUrl` | Must be a valid HTTPS URL |

**Success Response** (200 OK):
```json
{
  "id": "grp_abc123",
  "name": "Updated Group Name",
  "status": "inactive",
  "processingFeePercent": "3.00",
  "processingFeeCents": null,
  "paymentSuccessUrl": "https://newdomain.com/success",
  "paymentCancelUrl": "https://newdomain.com/cancel",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-03-10T16:20:00.000Z"
}
```

**Error Responses**:
- `400 Bad Request**: Invalid field value (see constraints above)
- `401 Unauthorized**: Missing or invalid JWT token
- `404 Not Found**: Group ID does not exist
- `500 Internal Server Error**: Database update failure

**Notes**:
- Setting `status` to `"inactive"` does not affect existing clients in the group
- `updatedAt` timestamp is automatically set on any update
- Null values clear the field
- Group ID cannot be changed after creation

---

## Testing & Debugging Notes

### Create Group
```bash
curl -X POST http://localhost:4242/api/v1/groups \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Small Business"}'
```

### List All Groups
```bash
curl http://localhost:4242/api/v1/groups \
  -H "Authorization: Bearer <jwt_token>"
```

### Update Group
```bash
curl -X PATCH http://localhost:4242/api/v1/groups/grp_abc123 \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "processingFeePercent": 2.9,
    "processingFeeCents": 30
  }'
```

### Common Issues

**"Group not found"**
- The group ID does not exist
- Fix: Verify ID with `GET /api/v1/groups`

**"Set one fee type, not both"**
- Cannot set both `processingFeePercent` and `processingFeeCents` simultaneously
- Choose either percentage-based or fixed-fee pricing

**"name must be a non-empty string"**
- Name cannot be empty or whitespace-only
- Fix: Provide a valid non-empty string

**HTTPS URL validation fails**
- URLs must start with `https://`
- HTTP URLs are rejected for security

---

## Usage Patterns

### Default Group Setup
Create a default group for standard clients:
```json
{
  "name": "Standard",
  "processingFeePercent": 2.9,
  "processingFeeCents": 30
}
```

### Enterprise Group Setup
Create a group with custom URLs and reduced fees:
```json
{
  "name": "Enterprise",
  "processingFeePercent": 1.5,
  "paymentSuccessUrl": "https://enterprise.client.com/success",
  "paymentCancelUrl": "https://enterprise.client.com/cancel"
}
```

### Deactivating a Group
Soft-delete a group without affecting existing clients:
```bash
curl -X PATCH http://localhost:4242/api/v1/groups/grp_abc123 \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"inactive"}'
```
