# Accepting Payments with the DFWSC Payment API

This guide is for developers integrating the DFWSC payment API into their own application. By the end you will be able to charge customers directly from your app while keeping them on your site.

**Prerequisites:** You have already been onboarded and received your API key. If you haven't, contact your DFWSC administrator.

---

## What You Have

After onboarding you should have been given:

- **API Key** — a long string of letters and numbers. This authenticates every request. Keep it secret — treat it like a password and never expose it in frontend code.
- **API Base URL** — the address of the payment server (e.g., `https://api.yourdfwscportal.com`)

---

## How It Works

1. Your backend calls the DFWSC API with the payment amount — it returns a `clientSecret`
2. Your frontend uses Stripe.js with that `clientSecret` to show a payment form to the customer
3. The customer fills in their card and submits — Stripe handles the actual charge
4. You get a webhook or redirect when the payment succeeds

Your customers never leave your site.

---

## Quick Start — Test Your API Key

```bash
curl -X POST https://<your-api-base-url>/api/v1/payments/create \
  -H "X-Api-Key: <your-api-key>" \
  -H "Idempotency-Key: test-001" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100, "currency": "usd" }'
```

If your key is working you'll get back a `clientSecret`. A `401` means your API key is wrong.

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
  "amount": 5000,
  "currency": "usd",
  "description": "Invoice #1234",
  "metadata": {
    "invoiceId": "1234",
    "customerName": "Jane Smith"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `amount` | Yes | Amount in **cents** — `5000` = $50.00 |
| `currency` | Yes | 3-letter currency code, e.g. `"usd"` |
| `description` | No | Shows up in your Stripe dashboard |
| `metadata` | No | Any key/value pairs you want attached to the payment |

### Response

```json
{
  "clientSecret": "pi_3OxyzABC_secret_def456",
  "paymentIntentId": "pi_3OxyzABC"
}
```

Pass the `clientSecret` to your frontend — do not log or store it.

---

## Step 2 — Show the Payment Form (Frontend)

Use Stripe.js to collect and submit the card. Stripe handles PCI compliance — you never touch raw card numbers.

### Add Stripe.js to your page

```html
<script src="https://js.stripe.com/v3/"></script>
```

### Mount the payment form

```javascript
const stripe = Stripe('<your-stripe-publishable-key>');

// clientSecret comes from your backend (Step 1)
const elements = stripe.elements({ clientSecret });

const paymentElement = elements.create('payment');
paymentElement.mount('#payment-element'); // mounts inside this div
```

```html
<form id="payment-form">
  <div id="payment-element"></div>
  <button type="submit">Pay Now</button>
  <div id="error-message"></div>
</form>
```

### Handle the form submission

```javascript
document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const { error } = await stripe.confirmPayment({
    elements,
    confirmParams: {
      return_url: 'https://yoursite.com/payment-complete',
    },
  });

  if (error) {
    document.getElementById('error-message').textContent = error.message;
  }
  // On success, Stripe redirects to return_url automatically
});
```

After successful payment, Stripe redirects the customer to your `return_url` with the payment status in the query string.

> Your **Stripe publishable key** (`pk_live_...` or `pk_test_...`) is different from your DFWSC API key. Find it in your Stripe dashboard under Developers > API keys.

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
      amount: amountCents,
      currency: 'usd',
      description,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Payment error: ${err.error}`);
  }

  return response.json(); // { clientSecret, paymentIntentId }
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
            'amount': amount_cents,
            'currency': 'usd',
            'description': description,
        }
    )
    response.raise_for_status()
    return response.json()  # { 'clientSecret': ..., 'paymentIntentId': ... }
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
            'amount'      => $amountCents,
            'currency'    => 'usd',
            'description' => $description,
        ]),
    ]);
    $result = curl_exec($ch);
    curl_close($ch);
    return json_decode($result, true); // ['clientSecret' => ..., 'paymentIntentId' => ...]
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
