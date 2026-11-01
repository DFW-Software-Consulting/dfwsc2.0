# Accepting Payments with the DFWSC Payment API

This guide is for developers integrating the DFWSC payment API into their own application. By the end you will be able to charge customers directly from your app.

**Prerequisites:** You have already been onboarded and received your API key. If you haven't, contact your DFWSC administrator.

> **Invoicing.** This guide also covers sending invoices to your own customers: see [Invoicing your customers](#invoicing-your-customers). It is optional and enabled per client by DFWSC.

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
- Sending a key again with a different request body returns `409 IDEMPOTENCY_KEY_REUSED`. Retrying it will not help: use a new key.

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
| `409` | The key was already used with a different request body (`code`: `IDEMPOTENCY_KEY_REUSED`) | No, not with this key. Generate a new `Idempotency-Key` for the new payment |
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

## Invoicing your customers

Besides taking one-off payments with Checkout, the API can create and send **invoices** to your own customers. Each invoice is created on your own Stripe account, so your customer pays you directly through a Stripe-hosted page, and Stripe emails the invoice when you ask it to. You never touch card data.

This is an optional feature that DFWSC turns on per client. Use the same `X-Api-Key` and the same base URL as for payments. All paths below start with `/api/v1`.

### Before you start

- **Enablement.** Ask your DFWSC administrator to turn on invoicing for your account. Until then every invoicing call returns `403` with `code: INVOICING_NOT_ENABLED`.
- **Charges must be enabled.** Calls that create or change things (create a customer, create, finalize or send an invoice, and so on) need a Stripe account that can take charges. If onboarding is not finished, or Stripe has switched charges off, they return `409` with `code: ACCOUNT_NOT_CONNECTED`. Reading, voiding and deleting a draft still work when charges are off, so you can read and cancel what you already created.
- **Card payments must be enabled.** Creating, finalizing and sending an invoice also need the `card_payments` capability to be active on your Stripe account. If it is not, those calls return `409` with `code: ACCOUNT_NOT_CONNECTED` and a message saying card payments are not enabled on the account yet; finish the account's Stripe onboarding and retry.
- Set these once in your shell for the examples below:

```sh
API=https://api.yourdfwscportal.com/api/v1
KEY=your-api-key
```

### The flow

```
Your backend                      DFWSC API                       Stripe             Your customer
    | POST /customers  ------------->|  create customer  ---------->|
    | POST /invoices   ------------->|  create DRAFT invoice ------>|                 (draft: not visible)
    | POST /invoices/:id/finalize -->|  finalize  ----------------->|                 (open: has hostedInvoiceUrl)
    | POST /invoices/:id/send  ----->|  send  --------------------->|---- email ----->|
    |                                |                              |<--- pays on hosted page
    | GET /invoices/:id  ----------->|  status = paid  <------ webhook / re-check
```

1. Create (or look up) a customer.
2. Create a draft invoice for that customer. A draft can still be deleted.
3. Finalize it. It becomes `open`, gets an invoice number and a `hostedInvoiceUrl`. A finalized invoice can no longer be edited, only voided.
4. Send it. Stripe emails the customer the invoice with a link to pay. (You can instead share `hostedInvoiceUrl` yourself.)
5. The customer pays on the hosted page. The invoice becomes `paid`. You learn this by reading the invoice (see "Tracking status").
6. To cancel: delete a `draft`, or void an `open` invoice.

### Customers

A customer is the person or company you invoice. It lives on your own Stripe account. DFWSC stores only its id and your `externalRef`.

**Create** (`Idempotency-Key` required):

```sh
curl -X POST "$API/customers" \
  -H "X-Api-Key: $KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "tenant@example.com",
    "name": "Pat Tenant",
    "phone": "+15555550123",
    "externalRef": "unit-4B",
    "metadata": { "building": "elm-street" }
  }'
```

Fields: `email` (required, valid address, max 320), `name` (max 256), `phone` (max 20), `externalRef` (1 to 100 characters), `metadata` (string keys and values; key at most 40 characters, value at most 500; at most 49 keys, or 48 when you also set `externalRef`, because the API adds its own `dfwsc_` keys to the 50 Stripe allows; keys starting with `dfwsc_` are reserved and rejected). Unknown fields are ignored.

> **`externalRef` must not contain personal data.** It is stored in DFWSC's database. Use your own opaque id (a unit number, an account id), never an email address, name or phone number. Email, name and phone are kept only on Stripe. The `Idempotency-Key` is also free text, so keep personal data out of it as well (only a hash of it is stored).

Response `201` (or `200` when the same key is replayed):

```json
{
  "id": "cus_123",
  "email": "tenant@example.com",
  "name": "Pat Tenant",
  "phone": "+15555550123",
  "externalRef": "unit-4B",
  "createdAt": "2026-11-01T15:00:00.000Z"
}
```

A second customer with an `externalRef` you already used returns `409 CUSTOMER_EXISTS` with the existing customer's `id` in the body, so you can use it.

**Get one, or look one up by `externalRef`:**

```sh
curl "$API/customers/cus_123" -H "X-Api-Key: $KEY"
curl "$API/customers?externalRef=unit-4B" -H "X-Api-Key: $KEY"
```

The `externalRef` lookup returns one customer, not a list (`400` if the query parameter is missing, `404` if nothing matches). There is no endpoint that lists all your customers; keep the ids you get back, or look them up by `externalRef`.

**Update** (at least one of `email`, `name`, `phone`; no `Idempotency-Key` needed):

```sh
curl -X PATCH "$API/customers/cus_123" \
  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "email": "new-address@example.com" }'
```

There is no way to delete a customer.

### Creating an invoice

```sh
curl -X POST "$API/invoices" \
  -H "X-Api-Key: $KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cus_123",
    "lines": [
      { "description": "November rent, unit 4B", "unitAmountCents": 150000 },
      { "description": "Parking space", "unitAmountCents": 5000, "quantity": 2 }
    ],
    "daysUntilDue": 14,
    "description": "Rent for November",
    "footer": "Thank you.",
    "metadata": { "unit": "4B" }
  }'
```

Fields: `customerId` (required; a customer you created through this API), `lines` (required, 1 to 50), `daysUntilDue` (1 to 365; default is your account's payment terms, else 30), `description` (max 1500), `footer` (max 500), `metadata` (key at most 40 characters, value at most 500, at most 48 keys; `dfwsc_` keys are reserved), `currency` (optional, only `usd`). Each line: `description` (1 to 500 characters), `unitAmountCents` (whole cents, above 0), `quantity` (whole number 1 to 999999, default 1).

`finalize` and `send` are not accepted on create: a body containing either is a `400`. Unknown fields such as a total or `waiveFee` are ignored; the server always computes the amounts itself.

Response `201` (the draft was created now) or `200` (a replay of a finished create):

```json
{
  "id": "in_1Abc",
  "number": null,
  "status": "draft",
  "customerId": "cus_123",
  "currency": "usd",
  "subtotalCents": 160000,
  "feeAmountCents": 3200,
  "totalCents": 163200,
  "amountPaidCents": 0,
  "amountRemainingCents": 163200,
  "dueDate": null,
  "hostedInvoiceUrl": null,
  "invoicePdf": null,
  "description": "Rent for November",
  "metadata": { "unit": "4B" },
  "createdAt": "2026-11-01T15:00:00.000Z",
  "finalizedAt": null,
  "paidAt": null,
  "voidedAt": null
}
```

(The amounts above are only an example. A draft has no `number`, `dueDate` or links yet.) `hostedInvoiceUrl` and `invoicePdf` are bearer links: anyone who has them can open the invoice, so do not publish them.

**Finalize** (no `Idempotency-Key`; finalizing an already open invoice returns `200` without doing it twice):

```sh
curl -X POST "$API/invoices/in_1Abc/finalize" -H "X-Api-Key: $KEY"
```

The invoice becomes `open`, with `number`, `dueDate` and `hostedInvoiceUrl`.

**Send** (`Idempotency-Key` required). Stripe emails the customer:

```sh
curl -X POST "$API/invoices/in_1Abc/send" \
  -H "X-Api-Key: $KEY" -H "Idempotency-Key: $(uuidgen)"
```

Only an `open` invoice can be sent. An invoice can be sent at most **3 times** (see "Idempotency and retries").

**Void** an open invoice (`void` is also allowed for an `uncollectible` one; no `Idempotency-Key`; a second call on a voided invoice returns `200`):

```sh
curl -X POST "$API/invoices/in_1Abc/void" -H "X-Api-Key: $KEY"
```

A `paid` invoice cannot be voided, and a draft is deleted rather than voided.

**Delete a draft** (only drafts; deleting an already deleted one returns `200`):

```sh
curl -X DELETE "$API/invoices/in_1Abc" -H "X-Api-Key: $KEY"
```

The response is the invoice with `status: "deleted"`.

**Read and list:**

```sh
curl "$API/invoices/in_1Abc" -H "X-Api-Key: $KEY"
curl "$API/invoices?status=open&customerId=cus_123&limit=25" -H "X-Api-Key: $KEY"
```

The list is newest first and returns `{ "data": [ ...invoices ], "nextCursor": "..." }`. Pass `nextCursor` back as `cursor` for the next page; it is `null` on the last page. `limit` is 1 to 100 (default 25), `status` is one of `draft`, `open`, `paid`, `void`, `uncollectible`, `deleted`, and a malformed `cursor` is a `400`. **Deleted invoices are left out of the list unless you pass `status=deleted`.** `GET /invoices/:id` still returns a deleted invoice.

### Money

- **Integer cents only.** `15000` is $150.00. Never send decimals or strings.
- **Currency is USD.** `currency` may be omitted; any other value is a `400`.
- **Limits.** A line's `unitAmountCents` is at most 99,999,999, and `unitAmountCents` times `quantity` may not exceed the invoice cap. The invoice **total, including the processing fee, is at most 2,500,000 cents ($25,000)**; above it the call returns `400 INVOICE_AMOUNT_TOO_LARGE`. At most 50 lines per invoice.
- **Daily limit.** At most 1000 invoices can be created per client in any rolling 24 hours, whatever their state (`429 INVOICE_DAILY_LIMIT`, with a `Retry-After` header).
- **DFWSC processing fee.** As with Checkout payments, DFWSC's fee is worked out from your account's fee settings (set by your administrator; you cannot change or waive it through the API). When it is above zero it is added to the invoice as a separate line called **"Processing Fee"**, so your customer pays the lines plus the fee, and DFWSC receives the fee as the application fee. If no fee is configured for your account, there is no fee line. `subtotalCents` is the sum of your lines, `feeAmountCents` is the fee, and `totalCents` is what the customer pays (lines plus fee). The fee is calculated once, when the invoice is created, and does not change afterwards.
- Stripe's own processing fees are not part of these amounts. Ask your DFWSC administrator who bears them on your account when invoicing is enabled.

### Idempotency and retries

Three calls require an `Idempotency-Key` header: `POST /customers`, `POST /invoices` and `POST /invoices/:id/send`. The key is trimmed and may be at most 255 characters; a missing or longer key returns `400`. Use a fresh UUID for each new thing you want to create or send, and store it with your own record. All other calls (`PATCH`, `finalize`, `void`, `DELETE`, reads) are safe to repeat as they are.

Rules for every call that takes a key:

- **Same key and same body again: same result.** Use this to retry after a timeout or a `5xx`. A finished create answers `200` with the stored object and nothing is created twice. Keys are scoped to your account.
- **Same key with a different body: `409 IDEMPOTENCY_KEY_REUSED`.** Retrying will not help. Use a new key for the new request.
- **Same key while the first request is still running: `409 IDEMPOTENCY_KEY_IN_USE`.** Wait a moment (a few seconds) and retry with the same key.
- **A `503` after Stripe already did the work** (`LEDGER_PERSISTENCE_FAILED`, `CUSTOMER_PERSISTENCE_FAILED`, `SEND_STATUS_UNKNOWN`) means: retry with the same key. It will not duplicate anything. A create that is interrupted half way is resumed from where it stopped.
- Stripe remembers a key for 24 hours. Retry within that time.

**Sends.** An invoice can be sent at most 3 times; each accepted `Idempotency-Key` is one send, and each one emails the customer.

- A **successful** send counts. A replay of that same key returns `200` from our records, sends no second email and does not count again.
- A send whose result is **unknown** (network error, `5xx`, Stripe rate limit, `SEND_STATUS_UNKNOWN`) counts, because the email may have gone out. Retry it with the **same** key; it is never emailed twice.
- A send that Stripe **definitely refused** does **not** count. That first request answers `502 SEND_REJECTED`, or `409 INVOICE_STATE_CHANGED` when the invoice is no longer open (for example it was paid or voided meanwhile). Its key is then marked failed, and repeating that key returns `409 SEND_FAILED`. **`SEND_FAILED` means: use a new `Idempotency-Key`** (and check the invoice status first; a new key on an invoice that is not open returns `409 INVOICE_NOT_SENDABLE`).
- A fourth send returns `409 SEND_LIMIT_REACHED`.

**Customer create replays compare against Stripe's current data.** To decide whether a replay is the same request, the API compares your body with the customer as it is now on Stripe (email compared ignoring case; missing and empty are equal). So if a create succeeded but you never saw the response, and the customer was then edited (by `PATCH` or in the Stripe dashboard), retrying the original body with the same key returns a false `409 IDEMPOTENCY_KEY_REUSED`. To recover: look the customer up with `GET /customers?externalRef=...` (this is a good reason to always set `externalRef`), or resend the same key with a body that matches the customer's current email, name, phone and metadata, which returns `200` with the customer. Do not create it again with a new key, or you may end up with a duplicate.

### Tracking status

Statuses: `draft`, `open`, `paid`, `void`, `uncollectible`, `deleted`. An invoice only moves forward:

| From | To | How |
|------|----|-----|
| `draft` | `open` | `POST /invoices/:id/finalize` |
| `draft` | `deleted` | `DELETE /invoices/:id` |
| `open` | `paid` | The customer pays on the hosted page |
| `open` | `void` | `POST /invoices/:id/void` |
| `open` | `uncollectible` | Marked in the Stripe dashboard |
| `uncollectible` | `paid` or `void` | Paid, or `POST /invoices/:id/void` |

`paid`, `void` and `deleted` are final. A late or repeated update never moves an invoice backwards (for example back from `paid` to `open`). A failed card attempt does not change the status; the invoice stays `open` and the customer can try again.

Status stays current in two ways. Stripe notifies DFWSC when an invoice is finalized, sent, paid, voided and so on, and DFWSC updates its record within seconds. In addition, `GET /invoices/:id` re-checks a `draft`, `open` or `uncollectible` invoice against Stripe when its record is older than 30 seconds, so a read is up to date even if a notification was missed. If that re-check fails, you get the stored record, not an error. The list (`GET /invoices`) reads DFWSC's records only. To find out whether an invoice was paid, read `GET /invoices/:id` and check `status` is `paid` (and `amountPaidCents`, `paidAt`). DFWSC does not send webhooks to you, so poll the invoices you are waiting on.

### Rate limits

- **Writes** (everything except reads): a token bucket per route and per Stripe account. It holds 300 requests and refills at 120 per minute. A request that fails validation, or is refused before it reaches Stripe, does not use up a token.
- **Reads** (`GET`): 600 requests per minute per client.
- Over the limit returns `429 RATE_LIMITED` with a `Retry-After` header (seconds). Wait that long plus a small random extra delay and retry with the same `Idempotency-Key`.
- Invoice creation also has the daily limit of 1000 described under "Money".
- A `503` with `Retry-After` (`STRIPE_BUSY`) means the service is queueing; retry after the header's value.

### Error reference

Errors have the shape `{ "error": "...", "code": "...", "requestId": "..." }`. Some `400` validation errors (a field that is missing or the wrong type) carry only `error`, and a `401` carries only `error`. Quote the `X-Request-Id` response header when you contact support.

| HTTP | `code` | Meaning | What to do |
|------|--------|---------|------------|
| 400 | `BAD_REQUEST` (or no code) | Invalid or missing field, missing or too long `Idempotency-Key`, reserved `dfwsc_` metadata key, `finalize` or `send` in the create body, bad `cursor` | Fix the request. The `error` text says what is wrong |
| 400 | `INVOICE_AMOUNT_TOO_LARGE` | A line or the total (with the fee) is over 2,500,000 cents | Split the invoice or lower the amount |
| 400 | `INVALID_REQUEST` | Stripe rejected a field of a customer or invoice-create request (`param` names it when known) | Fix the field and retry with a new `Idempotency-Key` (Stripe remembers its first answer for a key) |
| 401 | none | Missing, invalid or deactivated API key | Check `X-Api-Key` |
| 403 | `INVOICING_NOT_ENABLED` | Invoicing is not enabled for your account | Ask your DFWSC administrator |
| 404 | `NOT_FOUND` | Unknown customer or invoice, or one that belongs to another client | Check the id. For a customer in an invoice call, create the customer first |
| 409 | `ACCOUNT_NOT_CONNECTED` | Your Stripe account is not connected or cannot take charges | Finish Stripe onboarding, or ask DFWSC |
| 409 | `CUSTOMER_EXISTS` | That `externalRef` is already used; the body has the existing `id` | Use the returned `id` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The key was already used with a different request body (for a customer create, also a replay that no longer matches Stripe's current data, see above) | Use a new key for a new request, or follow the customer recovery steps above |
| 409 | `IDEMPOTENCY_KEY_IN_USE` | The first request with this key is still running | Wait a few seconds, retry with the same key |
| 409 | `ACCOUNT_CHANGED` | Your Stripe account changed since this invoice or key was first used | Contact DFWSC. Use a new key for a new invoice |
| 409 | `INVOICE_INCOMPLETE` | The invoice is still being created | Retry the create with its original `Idempotency-Key`, then continue |
| 409 | `INVOICE_IN_USE` | Another request is changing this invoice right now | Retry in a few seconds |
| 409 | `INVOICE_DELETED` | The invoice was deleted | Create a new invoice |
| 409 | `INVOICE_NOT_FINALIZABLE` | The invoice is deleted, paid, void or uncollectible | Read the invoice; nothing was changed |
| 409 | `INVOICE_NOT_VOIDABLE` | The invoice is a draft (delete it instead), paid or deleted | Use `DELETE` for a draft; nothing to do for the others |
| 409 | `INVOICE_NOT_DELETABLE` | Only drafts can be deleted | Void an open invoice instead |
| 409 | `INVOICE_NOT_SENDABLE` | Only open invoices can be sent | Finalize a draft first |
| 409 | `INVOICE_STATE_CHANGED` | The invoice changed (paid, voided, sent from the dashboard) while your request ran; the body has the current `status` | Read the invoice and decide again |
| 409 | `SEND_FAILED` | This send key was refused earlier | Use a new `Idempotency-Key` after checking the status |
| 409 | `SEND_LIMIT_REACHED` | The invoice was already sent 3 times | Share `hostedInvoiceUrl` yourself, or contact DFWSC |
| 429 | `RATE_LIMITED` | Rate limit (ours or Stripe's); `Retry-After` header | Wait, then retry with the same key |
| 429 | `INVOICE_DAILY_LIMIT` | 1000 invoices created in 24 hours; `Retry-After` header | Wait the number of seconds in the header |
| 500 | `INTERNAL_ERROR` | Server error | Contact DFWSC with the `X-Request-Id` |
| 502 | `STRIPE_REQUEST_REJECTED` | Stripe refused a finalize, void, delete or lookup for a reason that is not a state change | Read the invoice; contact DFWSC if it repeats |
| 502 | `SEND_REJECTED` | Stripe refused to send the invoice; the attempt did not count | Check the invoice, then retry with a new `Idempotency-Key` |
| 502 | `INVOICE_TOTAL_MISMATCH` | Stripe's total did not match the amount computed. The invoice was left as an unsent draft or not finalized | Contact DFWSC with the invoice id. Delete the draft if needed |
| 502 | `STRIPE_FAILED` | Stripe could not be reached or failed in an unclassified way | Retry with the same key; contact DFWSC if it persists |
| 503 | `STRIPE_CIRCUIT_OPEN` | The invoicing service is temporarily unavailable | Retry with the same key in about 30 seconds |
| 503 | `STRIPE_BUSY` | The service is busy; `Retry-After: 5` | Wait, then retry with the same key. Nothing was created |
| 503 | `LEDGER_PERSISTENCE_FAILED` | Stripe did the work but DFWSC could not record it | Repeat the same request (same key for create and send) |
| 503 | `CUSTOMER_PERSISTENCE_FAILED` | The customer was created but not recorded | Retry the create with the same key |
| 503 | `INVOICE_ADOPTION_INCOMPLETE` | A very old interrupted create could not be looked up safely; `Retry-After: 60` | Retry later with the same key, or contact DFWSC |
| 503 | `SEND_STATUS_UNKNOWN` | The send could not be confirmed (the email may have gone out); `Retry-After: 5` | Retry with the same key; it is never emailed twice |

---

## Need Help?

Contact your DFWSC administrator if:
- Your API key needs to be re-issued
- You're getting consistent `401` or `502` errors
- You need to update your post-payment redirect URL
