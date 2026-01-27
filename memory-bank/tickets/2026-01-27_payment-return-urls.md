# 2026-01-27 Payment Return URLs Per Client

## Summary
Checkout success and cancel routes currently redirect to the portal (`/payment-success` and `/payment-cancel`). We need a per-client return URL strategy so client customers can be redirected to their own sites after payment.

## Priority
Medium - Product requirement to support client-branded checkout flows

## Tasks

### 1. Store Per-Client Return URLs
**Files:** `backend/src/db/schema.ts`, migrations

**Recommendation:** Add `paymentSuccessUrl` and `paymentCancelUrl` (nullable) to the client record.

---

### 2. Validate Return URLs
**Files:** `backend/src/routes/payments.ts`, `backend/src/lib/validation.ts` (new if needed)

**Recommendation:** Validate and/or allowlist URLs per client to prevent open redirects.

---

### 3. Use Per-Client URLs in Checkout
**File:** `backend/src/routes/payments.ts`

**Recommendation:** When `USE_CHECKOUT=true`, use client-specific URLs if present, otherwise fall back to `${FRONTEND_ORIGIN}/payment-success` and `/payment-cancel`.

---

### 4. Optional: Frontend Redirect Strategy
**Files:** `front/src/pages/PaymentSuccess.jsx`, `front/src/pages/PaymentCancel.jsx`

**Recommendation:** If using a portal success page, consider redirecting to the client’s URL after showing a short confirmation.

## Acceptance Criteria
- [ ] Client records support `paymentSuccessUrl` and `paymentCancelUrl`
- [ ] Return URLs are validated/allowlisted
- [ ] Stripe Checkout sessions use per-client URLs when provided
- [ ] Fallbacks remain for clients without custom URLs

## Notes
- Ensure backward compatibility with existing clients
- Avoid open redirects by validating domains per client
