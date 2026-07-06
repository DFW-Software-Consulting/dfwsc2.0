# Accepting Payments with the DFWSC Payment API

This guide is for developers integrating the DFWSC payment API into their own application. By the end you will be able to charge customers directly from your app.

**Prerequisites:** You have already been onboarded and received your API key. If you haven't, contact your DFWSC administrator.

> **One payment flow: Stripe Checkout.** `POST /api/v1/payments/create` requires a `lineItems` array and returns a Stripe-hosted `url`. You redirect the customer to that URL; they complete payment on Stripe and are then sent back to your site. There is no embedded (Stripe Elements) mode.

---

## What You Have

After onboarding you should have been given:

- **API Key** — a long string of letters and numbers. This authenticates every request. Keep it secret — treat it like a password and never expose it in frontend code.
- **API Base URL** — the address of the payment server (e.g., `https://api.yourdfwscportal.com`)

---

## How It Works

1. Your backend calls the DFWSC API with a `lineItems` array — it returns a Stripe-hosted Checkout `url`
2. You redirect the customer to that `url`
3. The customer enters and submits their card on Stripe's hosted page — Stripe handles the actual charge
4. Stripe redirects the customer back to your success/cancel URL, and you get a webhook when the payment succeeds

The customer is briefly redirected off your site to Stripe Checkout — Stripe hosts the payment form, so you never touch card data.

---

## Quick Start — Test Your API Key

```bash
curl -X POST https://<your-api-base-url>/api/v1/payments/create \
  -H "X-Api-Key: <your-api-key>" \
  -H "Idempotency-Key: test-001" \
  -H "Content-Type: application/json" \
  -d '{ "lineItems": [{ "price_data": { "currency": "usd", "product_data": { "name": "Test" }, "unit_amount": 100 }, "quantity": 1 }] }'
```

If your key is working you'll get back a Stripe Checkout `url`. A `401` means your API key is wrong. Sending only `{ "amount": 100, "currency": "usd" }` returns `400 "lineItems are required."`.

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
| `Idempotency-Key` | A unique string for this payment attempt |
| `Content-Type` | `application/json` |

### What is an Idempotency Key?

Every request needs a unique `Idempotency-Key`. It prevents double-charges if a network error causes a retry. Use a UUID or your internal invoice/order ID.

If you accidentally send the same key twice, the second request returns the same result — no duplicate charge.

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
| `amount` | Only with price IDs | Explicit total in cents; required only when a line item references a Stripe price ID (`"price": "price_..."`) instead of `price_data` |

Amounts inside line items (`unit_amount`) are in **cents** (`5000` = $50.00).

### Response

```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

Redirect the customer to `url`. They complete payment on Stripe's hosted page and are returned to your success/cancel URL.

---

## Step 2 — Redirect the Customer (Frontend)

Send the customer's browser to the `url` from Step 1 — Stripe hosts the payment form:

```javascript
// After your backend gets { url } from Step 1:
window.location.href = url;
```

After payment, Stripe redirects the customer to your configured success URL (or the DFWSC default `/payment-success` page). Ask your DFWSC administrator to set your post-payment redirect URLs if you haven't already.

---

## Code Examples (Backend)

### Node.js

```javascript
const { randomUUID } = require('crypto');

async function createPayment(amountCents, description) {
  const response = await fetch('https://<your-api-base-url>/api/v1/payments/create', {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.DFWSC_API_KEY,
      'Idempotency-Key': randomUUID(),
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
    throw new Error(`Payment error: ${err.error}`);
  }

  return response.json(); // { url }
}
```

### Python

```python
import requests
import uuid

DFWSC_API_KEY = 'your-api-key'

def create_payment(amount_cents: int, description: str) -> dict:
    response = requests.post(
        'https://<your-api-base-url>/api/v1/payments/create',
        headers={
            'X-Api-Key': DFWSC_API_KEY,
            'Idempotency-Key': str(uuid.uuid4()),
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
    return response.json()  # { 'url': ... }
```

### PHP

```php
function createPayment(int $amountCents, string $description): array {
    $ch = curl_init('https://<your-api-base-url>/api/v1/payments/create');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => [
            'X-Api-Key: ' . DFWSC_API_KEY,
            'Idempotency-Key: ' . bin2hex(random_bytes(16)),
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
    return json_decode($result, true); // ['url' => ...]
}
```

---

## Error Handling

Errors return a JSON body with an `error` field:

```json
{ "error": "Description of what went wrong" }
```

| Status | Cause | Fix |
|--------|-------|-----|
| `400` | Missing or invalid field | Check request body — the error message says what's wrong |
| `401` | Bad or missing API key | Verify your `X-Api-Key` header |
| `429` | Too many requests | Slow down and retry |
| `500` | Server error | Contact DFWSC support |
| `502` | Stripe unreachable | Retry — usually temporary |

---

## Rules to Follow

- **Your API key goes on your backend only.** Never put it in frontend JavaScript or a mobile app binary.
- **Always use a unique `Idempotency-Key` per payment attempt.** Your invoice or order ID works great.
- **Amounts are in cents.** $1.00 = `100`, $25.50 = `2550`, $100.00 = `10000`.
- **Use HTTPS.** Never send your API key over plain HTTP.

---

## Need Help?

Contact your DFWSC administrator if:
- Your API key needs to be re-issued
- You're getting consistent `401` or `502` errors
- You need to update your post-payment redirect URL
