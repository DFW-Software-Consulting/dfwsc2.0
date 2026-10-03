# Accepting Payments with the DFWSC Payment API

This guide is for developers integrating the DFWSC payment API into their own application. By the end you will be able to charge customers directly from your app.

**Prerequisites:** You have already been onboarded and received your API key. If you haven't, contact your DFWSC administrator.

> **One payment flow: Stripe Checkout.** `POST /api/v1/payments/create` requires a `lineItems` array and returns a Stripe-hosted `url` and a `sessionId`. You redirect the customer to that URL; they complete payment on Stripe and are then sent back to your site. There is no embedded (Stripe Elements) mode.

---

## What You Have

After onboarding you should have been given:

- **API Key** — a long string of letters and numbers. This authenticates every request. Keep it secret — treat it like a password and never expose it in frontend code.
- **API Base URL** — the address of the payment server (e.g., `https://api.yourdfwscportal.com`)

---

## How It Works

1. Your backend calls the DFWSC API with a `lineItems` array — it returns a Stripe-hosted Checkout `url` and a `sessionId`. Store the `sessionId` with your order.
2. You redirect the customer to that `url`
3. The customer enters and submits their card on Stripe's hosted page — Stripe handles the actual charge
4. Stripe redirects the customer back to your success or cancel URL. The success URL always has `?session_id=...` added to it.
5. Your backend checks the session ID with the DFWSC API and only fulfils the order once the status is `paid`. The API does not send you a webhook, so this check is how you learn that a payment succeeded.

The customer is briefly redirected off your site to Stripe Checkout — Stripe hosts the payment form, so you never touch card data.

---

## Quick Start — Test Your API Key

```bash
curl -X POST https://<your-api-base-url>/api/v1/payments/create \
  -H "X-Api-Key: <your-api-key>" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "lineItems": [{ "price_data": { "currency": "usd", "product_data": { "name": "Test" }, "unit_amount": 100 }, "quantity": 1 }] }'
```

If your key is working you'll get back a Stripe Checkout `url` and a `sessionId`. A `401` means your API key is wrong. Sending only `{ "amount": 100, "currency": "usd" }` returns `400 "lineItems are required."`.

---

## Step 1 — Create a Payment (Backend)

Call this from your **server**, never from the browser.

```
POST /api/v1/payments/create
```

### Required Headers

| Header | Value |
|--------|-------|
| `X-Api-Key` | Your API key |
| `Idempotency-Key` | A new unique value (UUID) for each payment attempt |
| `Content-Type` | `application/json` |

### What is an Idempotency Key?

Every request needs an `Idempotency-Key`. Use a new unique value (a UUID) for each payment attempt and store it with your order. It prevents double-charges if a network error causes a retry: if a request fails or times out, retry the same request with the same key and you get the same result — no duplicate charge.

### Request Body

```json
{
  "lineItems": [
    {
      "price_data": {
        "currency": "usd",
        "product_data": { "name": "Invoice #1234" },
        "unit_amount": 5000
      },
      "quantity": 1
    }
  ],
  "metadata": {
    "invoiceId": "1234",
    "customerName": "Jane Smith"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `lineItems` | Yes | Non-empty array of items to charge, in Stripe Checkout `price_data` form. A bare `{ "amount", "currency" }` body returns `400 "lineItems are required."` |
| `description` | No | Shows up in your Stripe dashboard |
| `metadata` | No | Any key/value pairs you want attached to the payment |

Amounts inside line items (`unit_amount`) are in **cents** (`5000` = $50.00).

### Response

```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_..."
}
```

Save the `sessionId` against your own order right now, when you create the payment. You need it in Step 3 to confirm the payment.

---

## Step 2 — Redirect the Customer (Frontend)

Send the customer's browser to the `url` from Step 1 — Stripe hosts the payment form:

```javascript
// After your backend gets { url, sessionId } from Step 1:
window.location.href = url;
```

After payment, Stripe redirects the customer to your configured success URL (or the DFWSC default `/payment-success` page). On return to the success URL, `?session_id=...` is appended (or `&session_id=...` if your URL already has a query string), so you know which payment the customer is coming back from. Ask your DFWSC administrator to set your post-payment redirect URLs if you haven't already.

---

## Step 3 — Confirm the Payment (Backend)

Arriving on your success page does not prove the customer paid. Before you fulfil an order, check the payment from your **server** using the `sessionId` you saved in Step 1. No API key is needed for this call.

```
GET /api/v1/payments/session/{sessionId}
```

```json
{
  "status": "paid",
  "baseAmountCents": 5000,
  "totalAmountCents": 5500,
  "feeAmountCents": 500,
  "currency": "usd",
  "createdAt": "2026-01-15T14:32:10.000Z"
}
```

| Status | Meaning |
|--------|---------|
| `paid` | The customer paid. This is the only status to fulfil an order on. |
| `created` | Not finished yet. Wait a couple of seconds and check again. |
| `expired` | Not paid. The checkout session ran out of time. |
| `failed` | Not paid. The payment did not go through. |
| `canceled` | Not paid. The payment was canceled. |
| `refunded` | The customer paid, but the payment was later refunded. |
| `disputed` | The customer paid, but the payment was later disputed. |

- **Fulfil only on `paid`.** Compare `baseAmountCents` and `currency` to your order first. If they do not match, do not fulfil it.
- **Customers do not always come back.** If someone pays and closes the tab, your success page never loads. Re-check any order that is still pending using its stored `sessionId`.
- **Do not poll faster than every couple of seconds.** This endpoint is rate limited. If you get a `429`, wait and try again.

---

## Code Examples (Backend)

### Node.js

```javascript
// idempotencyKey: a UUID you generate once per payment attempt (for example with
// require('crypto').randomUUID()) and store with your order. If a request fails or
// times out, retry with the same key so you never create a second payment.
async function createPayment(amountCents, description, idempotencyKey) {
  const response = await fetch('https://<your-api-base-url>/api/v1/payments/create', {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.DFWSC_API_KEY,
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      lineItems: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: description },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      description,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Payment error ${response.status} (${err.code ?? 'no code'}): ${err.error}`);
  }

  return response.json(); // { url, sessionId } — store sessionId with your order
}

// Call this from your backend when the customer lands on your success URL
// (and for any order still pending later).
async function verifyPayment(sessionId, expectedAmountCents, expectedCurrency) {
  const response = await fetch(
    `https://<your-api-base-url>/api/v1/payments/session/${encodeURIComponent(sessionId)}`
  );

  if (!response.ok) {
    throw new Error(`Could not check payment: ${response.status}`); // 429 is retryable
  }

  const payment = await response.json();
  return (
    payment.status === 'paid' &&
    payment.baseAmountCents === expectedAmountCents &&
    payment.currency === expectedCurrency
  );
}
```

### Python

```python
import requests

DFWSC_API_KEY = 'your-api-key'

# idempotency_key: a UUID you generate once per payment attempt (str(uuid.uuid4()))
# and store with your order. If a request fails or times out, retry with the same
# key so you never create a second payment.
def create_payment(amount_cents: int, description: str, idempotency_key: str) -> dict:
    response = requests.post(
        'https://<your-api-base-url>/api/v1/payments/create',
        headers={
            'X-Api-Key': DFWSC_API_KEY,
            'Idempotency-Key': idempotency_key,
            'Content-Type': 'application/json',
        },
        json={
            'lineItems': [
                {
                    'price_data': {
                        'currency': 'usd',
                        'product_data': {'name': description},
                        'unit_amount': amount_cents,
                    },
                    'quantity': 1,
                }
            ],
            'description': description,
        }
    )
    response.raise_for_status()
    return response.json()  # { 'url': ..., 'sessionId': ... } — store sessionId with your order


# Call this from your backend when the customer lands on your success URL
# (and for any order still pending later).
def verify_payment(session_id: str, expected_amount_cents: int, expected_currency: str) -> bool:
    response = requests.get(
        f'https://<your-api-base-url>/api/v1/payments/session/{session_id}'
    )
    response.raise_for_status()  # a 429 is retryable
    payment = response.json()
    return (
        payment['status'] == 'paid'
        and payment['baseAmountCents'] == expected_amount_cents
        and payment['currency'] == expected_currency
    )
```

### PHP

```php
// $idempotencyKey: a UUID you generate once per payment attempt and store with your
// order. If a request fails or times out, retry with the same key so you never
// create a second payment.
function createPayment(int $amountCents, string $description, string $idempotencyKey): array {
    $ch = curl_init('https://<your-api-base-url>/api/v1/payments/create');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => [
            'X-Api-Key: ' . DFWSC_API_KEY,
            'Idempotency-Key: ' . $idempotencyKey,
            'Content-Type: application/json',
        ],
        CURLOPT_POSTFIELDS => json_encode([
            'lineItems' => [[
                'price_data' => [
                    'currency'     => 'usd',
                    'product_data' => ['name' => $description],
                    'unit_amount'  => $amountCents,
                ],
                'quantity' => 1,
            ]],
            'description' => $description,
        ]),
    ]);
    $result = curl_exec($ch);
    curl_close($ch);
    return json_decode($result, true); // ['url' => ..., 'sessionId' => ...] — store sessionId with your order
}

// Call this from your backend when the customer lands on your success URL
// (and for any order still pending later).
function verifyPayment(string $sessionId, int $expectedAmountCents, string $expectedCurrency): bool {
    $ch = curl_init(
        'https://<your-api-base-url>/api/v1/payments/session/' . rawurlencode($sessionId)
    );
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200) {
        return false; // a 429 is retryable — try again in a few seconds
    }

    $payment = json_decode($result, true);
    return $payment['status'] === 'paid'
        && $payment['baseAmountCents'] === $expectedAmountCents
        && $payment['currency'] === $expectedCurrency;
}
```

---

## Error Handling

Errors return a JSON body with an `error` message. Most errors also include a `code` you can branch on and a `requestId`:

```json
{
  "error": "Description of what went wrong",
  "code": "ERROR_CODE",
  "requestId": "..."
}
```

Every response also carries an `X-Request-Id` header. Log it, and quote it when you contact DFWSC support.

| Status | Cause | Fix |
|--------|-------|-----|
| `400` | Missing or invalid field | Check request body — the error message says what's wrong |
| `401` | Bad, missing or deactivated API key | Verify your `X-Api-Key` header. A deactivated client gets the same response — ask your DFWSC administrator |
| `409` | Stripe onboarding is not finished (`code`: `ACCOUNT_NOT_CONNECTED`) | Retrying will not help. Finish the Stripe onboarding for this account, or ask your DFWSC administrator to confirm it can accept charges |
| `429` | Too many requests | Slow down and retry |
| `500` | Server error | Contact DFWSC support and quote the `X-Request-Id` |
| `502` | Stripe unreachable | Retry with the same `Idempotency-Key` — usually temporary |
| `503` | The payment was created but could not be recorded (`code`: `LEDGER_PERSISTENCE_FAILED`), or the payment service is temporarily unavailable | Retry the same request with the same `Idempotency-Key`. Do not generate a new key, and do not fulfil the order until Step 3 reports `paid` |

---

## Rules to Follow

- **Your API key goes on your backend only.** Never put it in frontend JavaScript or a mobile app binary.
- **Always use a new `Idempotency-Key` (a UUID) per payment attempt.** Store it with your order and reuse it only to retry the same request.
- **Confirm before you fulfil.** Check `GET /api/v1/payments/session/{sessionId}` from your backend and fulfil only on `paid`. The API does not send webhooks.
- **Amounts are in cents.** $1.00 = `100`, $25.50 = `2550`, $100.00 = `10000`.
- **Use HTTPS.** Never send your API key over plain HTTP.

---

## Need Help?

Contact your DFWSC administrator if:
- Your API key needs to be re-issued
- You're getting consistent `401` or `502` errors
- You need to update your post-payment redirect URL
