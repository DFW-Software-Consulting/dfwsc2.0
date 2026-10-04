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
| `Idempotency-Key` | A new UUID for each payment attempt (at most 218 characters) |
| `Content-Type` | `application/json` |

### What is an Idempotency Key?

Every request needs an `Idempotency-Key`. It prevents double-charges if a network error causes a retry: if a request fails or times out, send the same request again with the same key and you get the same result — no duplicate charge.

A key identifies one payment attempt, not one order:

- **Generate a UUID per attempt** and store it with the `sessionId` you get back. Keys are scoped to your account, so another integrator's keys never clash with yours. A key can be at most 218 characters; a longer one returns `400` and the message states the exact limit.
- **Reuse a key only to repeat a request** that failed or timed out, with the same body, and never more than 24 hours after you first sent it.
- **Retire the key and generate a new one** when the customer abandons checkout and starts again later, when the order changed, or after a `400` that says Stripe rejected a field. Each new key creates a new Checkout session, and starting again does not cancel the earlier one: it stays payable until it expires (24 hours by default), so the customer can still pay in the earlier tab. Add the new `sessionId` to the order's list and keep the earlier ones; do not replace them. Step 3 explains how to check all of them.
- Sending a key again for a different payment returns `409 IDEMPOTENCY_KEY_REUSED`. Retrying it will not help: use a new key.

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

### Limits and retries

Many customers can pay at the same moment, for example when rent is due. Each account (the account behind your API key) can create **200 checkouts at once**, and the allowance refills at **120 per minute** (2 per second) as you use it. The portal's own limit admits a burst of 200; after that, you can keep going at 120 a minute. Admitted requests then queue for Stripe: the platform makes at most 25 Stripe calls at a time, and a request waits at most 10 seconds for its turn. When Stripe is slow, the tail of a large burst can run out of that time and get a `503` `STRIPE_BUSY` (below) instead of a checkout, so build in the retry. The limit is a backstop against a runaway loop or a leaked key, not a throttle on normal traffic.

When a request is refused, the response tells you when to try again:

- **`429`** with `code` `RATE_LIMITED` and a **`Retry-After`** header: the whole number of seconds to wait (at least 1). Every `429` from this API carries both. You also get a `429` if Stripe itself is rate limiting the platform; then `Retry-After` is `2`.
- **`503`** with `code` `STRIPE_BUSY` and `Retry-After: 5`: the platform is already making its maximum of 25 Stripe calls at once, and yours did not get its turn within 10 seconds (or too many requests were already waiting). Nothing was created.

**Retry automatically, with the same `Idempotency-Key`.** On a `429` or a `503`, wait the `Retry-After` seconds **plus a small random extra delay** (for example up to one second, chosen separately for each request) and send the same request again with the same key, while your customer sees a waiting screen such as "Preparing your payment...". The customer should never have to click twice, and you should not generate a new key: a refused request created nothing, and a request that did get through is never created a second time under the same key. The random extra matters when many requests are refused together, as in a rent-day burst: if they all wait exactly the same time, they all come back at the same moment and are refused again. If the request is still refused after a few minutes of retries, stop and contact DFWSC support with the `X-Request-Id`.

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

Arriving on your success page does not prove the customer paid. Before you fulfil an order, check the payment from your **server** using the `sessionId` you saved in Step 1 (every `sessionId` you saved, if the customer started checkout more than once for the order).

Send your `X-Api-Key` header with this call. It is optional, but it changes the limit:

- **With `X-Api-Key`:** up to 600 requests per minute for your account, shared by every session you check. You only see your own account's sessions: a session that belongs to another account returns `404`, the same as an unknown session. A wrong or deactivated key returns `401`; it is not treated as an anonymous call. Rejected keys are counted per calling IP address, once for each different key: sending the same wrong key again and again uses one of the 30 allowed in a minute, so one stale key does not stop your other keys from working. After 30 different rejected keys in a minute, further calls from that address that send a key not checked successfully within the last minute get a `429` with a `Retry-After` header until the minute has passed, without the key being checked. Successful calls are never counted, and a key that was checked successfully within the last minute is still served. A key that has been rejected keeps getting `401` for up to a minute without being checked again; if its account is then reactivated, the key works again within that minute (at once when DFWSC reactivates it).
- **Without it:** the call is anonymous and limited to 30 requests per minute for each calling IP address, shared by everything calling from that address. This is the limit a customer's browser has when it loads the payment success page.

Other errors from this call: `400` for a `sessionId` that is not a Checkout session ID, and `404` for an unknown session. A `429` carries `code` `RATE_LIMITED` and a `Retry-After` header, as above.

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
| `created` | Not finished yet. Check again later, using the schedule below. |
| `expired` | Not paid. The checkout session ran out of time. |
| `failed` | Not paid. The payment did not go through. |
| `canceled` | Not paid. The payment was canceled. |
| `refunded` | The customer paid, but the payment was later refunded. |
| `disputed` | The customer paid, but the payment was later disputed. |

- **Fulfil only on `paid`.** Compare `baseAmountCents` and `currency` to your order first. If they do not match, do not fulfil it.
- **Customers do not always come back.** If someone pays and closes the tab, your success page never loads. Re-check any order that is still pending using its stored `sessionId`.
- **Check every session of an order, not just the newest.** Starting checkout again does not cancel the earlier session, so it stays payable until it expires and the customer can still pay in an earlier tab. Check all of the order's stored `sessionId`s until each one is `paid` or `expired`. If an earlier session comes back `paid`, the order is paid: fulfil it once (if the amount matches, as above) and do not send the customer to pay again. If two sessions for the same order both come back `paid`, the customer paid twice: fulfil the order once and refund the extra payment from your Stripe dashboard, because this portal has no refund endpoint. If the order changed after an earlier session was created, that session still carries the old amount; a `paid` result whose amount no longer matches the order must not be fulfilled, and the payment needs to be reconciled or refunded in your Stripe dashboard.
- **Send your API key and back off when you poll.** Sent with your `X-Api-Key`, this endpoint allows 600 requests per minute for your account, shared by every session you check; without the key it allows 30 requests per minute for each calling IP address. Check once when the customer lands on the success URL, then again after about 2, 5 and 10 seconds. If the status is still `created`, leave the order to a background job. Treat that job's polling as one budget shared by all your pending orders, not a rate per order: check a pending order once a minute for its first ten minutes, then every 15 minutes, and stop once the status is `expired` or 24 hours have passed since you created it (an abandoned checkout stays `created` until Stripe expires it). Keep the job's total to about 300 requests a minute across every order, so the check you make when a customer returns to the success URL always has headroom; if more orders are due than fit, check the oldest first and let the rest wait for the next minute. On a `429`, wait the number of seconds in its `Retry-After` header, plus a small random extra delay, before the next attempt instead of retrying straight away.

---

## Code Examples (Backend)

### Node.js

```javascript
// idempotencyKey: a UUID you generate once per payment attempt (for example with
// require('crypto').randomUUID()) and store with the sessionId. If a request fails or
// times out, retry with the same key (within 24 hours) so you never create a second
// payment. If the customer starts checkout again, generate a new key.
// A 429 or 503 means wait, then try again: wait the number of seconds in the Retry-After
// response header plus a small random extra delay (for example up to one second, different
// for each request) and call this again with the same idempotencyKey while the customer sees
// a waiting screen. Do not ask them to click again.
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
    // A proxy error during a deploy has no JSON body, so do not assume one.
    const err = await response.json().catch(() => ({}));
    throw new Error(`Payment error ${response.status} (${err.code ?? 'no code'}): ${err.error ?? 'no message'}`);
  }

  return response.json(); // { url, sessionId } — store sessionId with your order
}

// Call this from your backend when the customer lands on your success URL
// (and for any order still pending later).
async function verifyPayment(sessionId, expectedAmountCents, expectedCurrency) {
  const response = await fetch(
    `https://<your-api-base-url>/api/v1/payments/session/${encodeURIComponent(sessionId)}`,
    { headers: { 'X-Api-Key': process.env.DFWSC_API_KEY } }
  );

  if (!response.ok) {
    // A 429 is retryable: wait its Retry-After seconds plus a small random delay before checking again.
    throw new Error(`Could not check payment: ${response.status}`);
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
# and store with the sessionId. If a request fails or times out, retry with the same
# key (within 24 hours) so you never create a second payment. If the customer starts
# checkout again, generate a new key.
# A 429 or 503 means wait, then try again: wait the number of seconds in the Retry-After
# response header plus a small random extra delay (for example up to one second, different
# for each request) and call this again with the same idempotency_key while the customer sees
# a waiting screen. Do not ask them to click again.
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
        f'https://<your-api-base-url>/api/v1/payments/session/{session_id}',
        headers={'X-Api-Key': DFWSC_API_KEY},
    )
    response.raise_for_status()  # a 429 is retryable: wait its Retry-After seconds plus a small random delay
    payment = response.json()
    return (
        payment['status'] == 'paid'
        and payment['baseAmountCents'] == expected_amount_cents
        and payment['currency'] == expected_currency
    )
```

### PHP

```php
// $idempotencyKey: a UUID you generate once per payment attempt and store with the
// sessionId. If a request fails or times out, retry with the same key (within 24
// hours) so you never create a second payment. If the customer starts checkout
// again, generate a new key.
// A 429 or 503 means wait, then try again: wait the number of seconds in the Retry-After
// response header plus a small random extra delay (for example up to one second, different
// for each request) and call this again with the same $idempotencyKey while the customer sees
// a waiting screen. Do not ask them to click again.
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
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['X-Api-Key: ' . DFWSC_API_KEY]);
    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200) {
        return false; // a 429 is retryable: wait its Retry-After seconds plus a small random delay
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

These are the statuses `POST /api/v1/payments/create` can return for a failed request.

| Status | Cause | Retry? |
|--------|-------|--------|
| `400` | Missing or invalid field, an `Idempotency-Key` that is too long, or Stripe rejected a field of the request (`code`: `INVALID_REQUEST`, with `param` naming the field when Stripe says which) | No. Fix the request; the error message says what is wrong. After `INVALID_REQUEST`, send the corrected request with a new `Idempotency-Key`, because Stripe keeps its first answer for a key, errors included, for 24 hours |
| `401` | Bad, missing or deactivated API key | No. Verify your `X-Api-Key` header. A deactivated client gets the same response — ask your DFWSC administrator |
| `402` | The card was declined (`code`: `CARD_DECLINED`) | No, not with the same key. Start a new attempt with a new `Idempotency-Key` |
| `409` | Stripe onboarding is not finished, or the account cannot take payments (`code`: `ACCOUNT_NOT_CONNECTED`) | No. Finish the Stripe onboarding for this account, or ask your DFWSC administrator to confirm it can accept charges |
| `409` | The key was already used for a different payment (`code`: `IDEMPOTENCY_KEY_REUSED`) | No, not with this key. Generate a new `Idempotency-Key` for the new payment |
| `409` | A request with this key is still in progress (`code`: `IDEMPOTENCY_KEY_IN_USE`) | Yes. Wait a moment and retry the same request with the same key |
| `429` | Too many requests, or Stripe is rate limiting the platform (`code`: `RATE_LIMITED`). The response has a `Retry-After` header | Yes. Wait the `Retry-After` seconds plus a small random extra delay, then retry automatically with the same key |
| `500` | Server error | Contact DFWSC support and quote the `X-Request-Id` |
| `502` | Stripe could not be reached, or failed in a way that is not covered above (`code`: `STRIPE_FAILED`) | Yes, with the same key. If it still fails after a few attempts, stop and contact DFWSC support with the `X-Request-Id` |
| `503` | The payment service is busy with other requests (`code`: `STRIPE_BUSY`). The response has `Retry-After: 5` | Yes. Wait the `Retry-After` seconds plus a small random extra delay, then retry automatically with the same key, while the customer sees a waiting screen. Nothing was created |
| `503` | The payment service is temporarily unavailable (`code`: `STRIPE_CIRCUIT_OPEN`), or the payment was created but could not be recorded (`code`: `LEDGER_PERSISTENCE_FAILED`) | Yes. Retry the same request with the same key; the first usually clears within about 30 seconds. Do not generate a new key, and do not fulfil the order until Step 3 reports `paid` |

A `502` or `503` returned while the API restarts during a deploy comes from the proxy in front of it, so it has neither this JSON body nor the `X-Request-Id` header. Check the status code before you parse the body.

---

## Rules to Follow

- **Your API key goes on your backend only.** Never put it in frontend JavaScript or a mobile app binary.
- **Always use a new `Idempotency-Key` (a UUID) per payment attempt.** A key covers one attempt, not one order. Store it with the `sessionId`, reuse it only to retry a failed or timed-out request within 24 hours, and generate a new one when the customer starts checkout again. Keep every `sessionId` you create for an order: an earlier session stays payable until it expires.
- **Confirm before you fulfil.** Check `GET /api/v1/payments/session/{sessionId}` from your backend and fulfil only on `paid`. The API does not send webhooks.
- **Retry `429` and `503` automatically.** Wait the `Retry-After` seconds plus a small random extra delay, then send the same request with the same `Idempotency-Key`, and show the customer a waiting screen so they never have to click twice.
- **Amounts are in cents.** $1.00 = `100`, $25.50 = `2550`, $100.00 = `10000`.
- **Use HTTPS.** Never send your API key over plain HTTP.

---

## Need Help?

Contact your DFWSC administrator if:
- Your API key needs to be re-issued
- You're getting consistent `401` or `502` errors
- You need to update your post-payment redirect URL
