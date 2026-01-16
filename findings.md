# Findings

## Critical
- `backend/src/lib/auth.ts:7-15` + `backend/src/routes/payments.ts:18-22`: `/payments/create` is authorized only by the `x-api-role` header, which is trivially spoofed by any caller. This effectively bypasses authentication for payment creation.

## High
- `backend/src/routes/connect.ts:153-155`: Stripe onboarding callback URL uses `/v1/connect/callback`, but routes are mounted under `/api/v1`; this will 404.
- `backend/src/routes/connect.ts:183-185`: Redirects to `/onboarding-success.html`, but no such page exists in the frontend; users will land on a 404 after Stripe onboarding.
- `backend/src/routes/payments.ts:117-118` + `front/src/App.jsx:20-25`: Checkout success/cancel URLs use `/payments/success` and `/payments/cancel`, but the frontend only defines `/payment-success`; redirects will fail.

## Medium
- `front/src/pages/OnboardClient.jsx:25-27`, `front/src/components/admin/AdminLogin.jsx:38-40`, `front/src/components/admin/CreateClientForm.jsx:49-51`, `front/src/components/admin/AdminDashboard.jsx:33-36`: Frontend appends `/v1` to `VITE_API_URL`, which is documented as already `/api/v1`; default envs will call `/api/v1/v1/...`.
- `backend/src/routes/payments.ts:29-78,97-121`: `applicationFeeAmount` from the request is ignored and `DEFAULT_PROCESS_FEE_CENTS` is always used, which conflicts with the README’s stated behavior.
