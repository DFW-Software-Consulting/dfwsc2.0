import { useState } from "react";
import { Link } from "react-router-dom";

const sidebarSections = [
  { id: "what-you-have", label: "What You Have" },
  { id: "how-it-works", label: "How It Works" },
  { id: "quick-start", label: "Quick Start" },
  { id: "step-1", label: "Step 1 — Create a Payment" },
  { id: "step-2", label: "Step 2 — Redirect to Checkout" },
  { id: "step-3", label: "Step 3 — Confirm the Payment" },
  { id: "code-examples", label: "Code Examples" },
  { id: "error-handling", label: "Error Handling" },
  { id: "rules", label: "Rules" },
  { id: "need-help", label: "Need Help?" },
];

function CodeBlock({ children, language }) {
  return (
    <div className="relative group my-6 transition-colors duration-300">
      <div className="absolute -inset-px rounded-xl bg-gradient-to-r from-brand-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <pre className="relative rounded-xl border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-black/40 backdrop-blur-sm overflow-x-auto p-5 font-mono text-sm text-slate-700 dark:text-slate-300 leading-relaxed shadow-xl dark:shadow-2xl transition-colors">
        {language && (
          <div className="flex items-center justify-between mb-4 border-b border-slate-200 dark:border-white/5 pb-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-600 dark:text-brand-500">
              {language}
            </span>
            <div className="flex gap-1.5">
              <div className="h-2 w-2 rounded-full bg-slate-200 dark:bg-white/10" />
              <div className="h-2 w-2 rounded-full bg-slate-200 dark:bg-white/10" />
              <div className="h-2 w-2 rounded-full bg-slate-200 dark:bg-white/10" />
            </div>
          </div>
        )}
        <code>{children}</code>
      </pre>
    </div>
  );
}

function SectionBadge({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-brand-500/20 bg-brand-500/5 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-brand-600 dark:text-brand-400 transition-colors">
      {children}
    </span>
  );
}

function SectionAnchor({ id }) {
  return <span id={id} className="-mt-32 block pt-32" aria-hidden="true" />;
}

const NODE_CODE = `// idempotencyKey: a UUID you generate once per payment attempt (for example with
// require('crypto').randomUUID()) and store with the sessionId. If a request fails or
// times out, retry with the same key (within 24 hours) so you never create a second
// payment. If the customer starts checkout again, generate a new key.
// A 429 or 503 means wait, then try again: wait the number of seconds in the Retry-After
// response header plus a small random extra delay (for example up to one second, different
// for each request) and call this again with the same idempotencyKey while the customer sees
// a waiting screen. Do not ask them to click again.
async function createPayment(amountCents, description, idempotencyKey) {
  const response = await fetch(
    'https://<your-api-base-url>/api/v1/payments/create',
    {
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
    }
  );

  if (!response.ok) {
    // A proxy error during a deploy has no JSON body, so do not assume one.
    const err = await response.json().catch(() => ({}));
    throw new Error(\`Payment error \${response.status} (\${err.code ?? 'no code'}): \${err.error ?? 'no message'}\`);
  }

  return response.json(); // { url, sessionId } — store sessionId with your order
}

// Call this from your backend when the customer lands on your success URL
// (and for any order still pending later).
async function verifyPayment(sessionId, expectedAmountCents, expectedCurrency) {
  const response = await fetch(
    \`https://<your-api-base-url>/api/v1/payments/session/\${encodeURIComponent(sessionId)}\`,
    { headers: { 'X-Api-Key': process.env.DFWSC_API_KEY } }
  );

  if (!response.ok) {
    // A 429 is retryable: wait its Retry-After seconds plus a small random delay before checking again.
    throw new Error(\`Could not check payment: \${response.status}\`);
  }

  const payment = await response.json();
  return (
    payment.status === 'paid' &&
    payment.baseAmountCents === expectedAmountCents &&
    payment.currency === expectedCurrency
  );
}`;

const PYTHON_CODE = `import requests

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
    )`;

const PHP_CODE = `// $idempotencyKey: a UUID you generate once per payment attempt and store with the
// sessionId. If a request fails or times out, retry with the same key (within 24
// hours) so you never create a second payment. If the customer starts checkout
// again, generate a new key.
// A 429 or 503 means wait, then try again: wait the number of seconds in the Retry-After
// response header plus a small random extra delay (for example up to one second, different
// for each request) and call this again with the same $idempotencyKey while the customer sees
// a waiting screen. Do not ask them to click again.
function createPayment(int $amountCents, string $description, string $idempotencyKey): array {
    $ch = curl_init(
        'https://<your-api-base-url>/api/v1/payments/create'
    );
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
}`;

const LANG_TABS = [
  { id: "node", label: "Node.js", code: NODE_CODE, language: "javascript" },
  { id: "python", label: "Python", code: PYTHON_CODE, language: "python" },
  { id: "php", label: "PHP", code: PHP_CODE, language: "php" },
];

const ERROR_ROWS = [
  {
    status: "400",
    cause:
      'Missing or invalid field, an Idempotency-Key that is too long, or Stripe rejected a field of the request (code "INVALID_REQUEST", with param naming the field when Stripe says which)',
    retry:
      "No. Fix the request; the error message says what is wrong. After INVALID_REQUEST, send the corrected request with a new Idempotency-Key, because Stripe keeps its first answer for a key, errors included, for 24 hours",
  },
  {
    status: "401",
    cause: "Bad, missing or deactivated API key",
    retry:
      "No. Verify your X-Api-Key header. A deactivated client gets the same response — ask your DFWSC administrator",
  },
  {
    status: "402",
    cause: 'The card was declined (code "CARD_DECLINED")',
    retry: "No, not with the same key. Start a new attempt with a new Idempotency-Key",
  },
  {
    status: "409",
    cause:
      'Stripe onboarding is not finished, or the account cannot take payments (code "ACCOUNT_NOT_CONNECTED")',
    retry:
      "No. Finish the Stripe onboarding for this account, or ask your DFWSC administrator to confirm it can accept charges",
  },
  {
    status: "409",
    cause: 'The key was already used for a different payment (code "IDEMPOTENCY_KEY_REUSED")',
    retry: "No, not with this key. Generate a new Idempotency-Key for the new payment",
  },
  {
    status: "409",
    cause: 'A request with this key is still in progress (code "IDEMPOTENCY_KEY_IN_USE")',
    retry: "Yes. Wait a moment and retry the same request with the same key",
  },
  {
    status: "429",
    cause:
      'Too many requests, or Stripe is rate limiting the platform (code "RATE_LIMITED"). The response has a Retry-After header',
    retry:
      "Yes. Wait the Retry-After seconds plus a small random extra delay, then retry automatically with the same key",
  },
  {
    status: "500",
    cause: "Server error",
    retry: "Contact DFWSC support and quote the X-Request-Id response header",
  },
  {
    status: "502",
    cause:
      'Stripe could not be reached, or failed in a way that is not covered above (code "STRIPE_FAILED")',
    retry:
      "Yes, with the same key. If it still fails after a few attempts, stop and contact DFWSC support with the X-Request-Id",
  },
  {
    status: "503",
    cause:
      'The payment service is busy with other requests (code "STRIPE_BUSY"). The response has Retry-After: 5',
    retry:
      "Yes. Wait the Retry-After seconds plus a small random extra delay, then retry automatically with the same key, while the customer sees a waiting screen. Nothing was created",
  },
  {
    status: "503",
    cause:
      'The payment service is temporarily unavailable (code "STRIPE_CIRCUIT_OPEN"), or the payment was created but could not be recorded (code "LEDGER_PERSISTENCE_FAILED")',
    retry:
      "Yes. Retry the same request with the same key; the first usually clears within about 30 seconds. Do not generate a new key, and do not fulfil the order until Step 3 reports paid",
  },
];

const STATUS_ROWS = [
  { status: "paid", meaning: "The customer paid. This is the only status to fulfil an order on." },
  {
    status: "created",
    meaning: "Not finished yet. Check again later, using the schedule below.",
  },
  { status: "expired", meaning: "Not paid. The checkout session ran out of time." },
  { status: "failed", meaning: "Not paid. The payment did not go through." },
  { status: "canceled", meaning: "Not paid. The payment was canceled." },
  { status: "refunded", meaning: "The customer paid, but the payment was later refunded." },
  { status: "disputed", meaning: "The customer paid, but the payment was later disputed." },
];

export default function Docs() {
  const [activeLang, setActiveLang] = useState("node");

  const handleSidebarClick = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  const activeLangTab = LANG_TABS.find((t) => t.id === activeLang);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8 sm:py-24 transition-colors duration-300">
      {/* Page header */}
      <div className="mb-20">
        <SectionBadge>Developer Reference</SectionBadge>
        <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-6xl text-gradient transition-colors">
          Connect Your App
        </h1>
        <p className="mt-8 max-w-2xl text-xl text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
          Everything you need to accept payments through the DFWSC platform — your backend creates
          the payment and your customer pays on a secure Stripe-hosted checkout page.
        </p>
        <div className="mt-8 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 transition-colors">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
          Prerequisites: you have already been onboarded and received your API key. If not,{" "}
          <Link
            to="/"
            state={{ scrollTo: "contact" }}
            className="text-brand-600 dark:text-brand-400 font-bold hover:text-brand-700 dark:hover:text-brand-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 rounded-sm"
          >
            contact us
          </Link>
          .
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-16">
        {/* Sidebar — hidden on mobile, shown on lg+ */}
        <aside className="hidden lg:block w-64 flex-none">
          <nav className="sticky top-32 space-y-1" aria-label="Page sections">
            <h3 className="px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400 mb-4 transition-colors">
              On this page
            </h3>
            {sidebarSections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleSidebarClick(s.id)}
                className="group flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 dark:text-slate-300 transition-all duration-200 hover:bg-slate-100 dark:hover:bg-white/[0.03] hover:text-brand-700 dark:hover:text-white cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-transparent group-hover:bg-brand-500 mr-3 transition-colors" />
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Mobile sidebar — horizontal pill list */}
        <div className="lg:hidden -mx-4 mb-12 flex gap-3 overflow-x-auto px-4 pb-4 border-b border-slate-200 dark:border-white/5 transition-colors">
          {sidebarSections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => handleSidebarClick(s.id)}
              className="flex-none rounded-xl border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] px-4 py-2 text-xs font-bold text-slate-700 dark:text-slate-300 transition hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-slate-900 dark:hover:text-white cursor-pointer whitespace-nowrap uppercase tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Main content */}
        <main className="min-w-0 flex-1 space-y-24">
          {/* What You Have */}
          <section>
            <SectionAnchor id="what-you-have" />
            <SectionBadge>Credentials</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              What You Have
            </h2>
            <p className="mt-4 text-lg text-slate-700 dark:text-slate-300 transition-colors">
              After onboarding you should have received:
            </p>
            <div className="mt-8 grid gap-4">
              {[
                {
                  label: "API Key",
                  desc: "A long string of letters and numbers. Authenticates every request. Keep it secret — treat it like a password and never expose it in frontend code.",
                },
                {
                  label: "API Base URL",
                  desc: "The address of the payment server (e.g., https://api.yourdfwscportal.com).",
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] transition-all hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm"
                >
                  <h3 className="font-bold text-slate-900 dark:text-white text-lg transition-colors">
                    {item.label}
                  </h3>
                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* How It Works */}
          <section>
            <SectionAnchor id="how-it-works" />
            <SectionBadge>Overview</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              How It Works
            </h2>
            <div className="mt-8 space-y-6">
              {[
                {
                  id: "backend-url",
                  content: (
                    <>
                      Your backend calls the DFWSC API with a{" "}
                      <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                        lineItems
                      </code>{" "}
                      array — it returns a Stripe-hosted Checkout{" "}
                      <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                        url
                      </code>{" "}
                      and a{" "}
                      <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                        sessionId
                      </code>
                      . Store the{" "}
                      <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                        sessionId
                      </code>{" "}
                      with your order.
                    </>
                  ),
                },
                {
                  id: "frontend-redirect",
                  content: (
                    <>
                      You redirect the customer to that{" "}
                      <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                        url
                      </code>
                      .
                    </>
                  ),
                },
                {
                  id: "customer-submits",
                  content:
                    "The customer enters their card on Stripe's hosted page — Stripe handles the actual charge.",
                },
                {
                  id: "webhook-redirect",
                  content:
                    "Stripe sends the customer back to your success or cancel URL when they finish. The success URL always has ?session_id=... added to it.",
                },
                {
                  id: "confirm-payment",
                  content:
                    "Your backend checks the session ID with the DFWSC API and only fulfils the order once the status is paid.",
                },
              ].map((step, i) => (
                <div key={step.id} className="flex items-start gap-6 group">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-500/20 bg-brand-500/5 text-sm font-black text-brand-600 dark:text-brand-400 group-hover:bg-brand-500 group-hover:text-white transition-all">
                    {i + 1}
                  </span>
                  <div className="pt-2 text-base text-slate-600 dark:text-slate-300 leading-relaxed transition-colors">
                    {step.content}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-10 p-6 rounded-2xl border border-brand-500/10 bg-brand-500/5 text-brand-600 dark:text-brand-200 font-bold text-center transition-colors">
              Stripe hosts the payment page — you never touch card data.
            </div>
          </section>

          {/* Quick Start */}
          <section>
            <SectionAnchor id="quick-start" />
            <SectionBadge>Quick Start</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Test Your API Key
            </h2>
            <p className="mt-4 text-lg text-slate-700 dark:text-slate-300 transition-colors">
              Run this curl command to confirm your key works. A successful response includes a
              Stripe Checkout url and a sessionId.
            </p>
            <CodeBlock language="bash">{`curl -X POST https://<your-api-base-url>/api/v1/payments/create \\
  -H "X-Api-Key: <your-api-key>" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "lineItems": [{ "price_data": { "currency": "usd", "product_data": { "name": "Test" }, "unit_amount": 100 }, "quantity": 1 }] }'`}</CodeBlock>
          </section>

          {/* Step 1 */}
          <section>
            <SectionAnchor id="step-1" />
            <SectionBadge>Backend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Step 1 — Create a Payment
            </h2>
            <p className="mt-4 text-lg text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              Call this from your{" "}
              <strong className="text-slate-900 dark:text-white underline decoration-brand-500/50 transition-colors">
                server
              </strong>
              , never from the browser.
            </p>

            <div className="mt-8 p-4 rounded-xl border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] font-mono text-brand-600 dark:text-brand-400 font-bold transition-colors">
              POST /api/v1/payments/create
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Required Headers
            </h3>
            <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors">
              <table className="w-full text-sm text-slate-700 dark:text-slate-300 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Header
                    </th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["X-Api-Key", "Your API key"],
                    [
                      "Idempotency-Key",
                      "A new UUID for each payment attempt (at most 218 characters)",
                    ],
                    ["Content-Type", "application/json"],
                  ].map(([header, value]) => (
                    <tr
                      key={header}
                      className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]"
                    >
                      <td className="px-6 py-4 font-mono text-brand-600 dark:text-brand-300">
                        {header}
                      </td>
                      <td className="px-6 py-4">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-12 p-8 rounded-[2rem] border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] transition-colors">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white transition-colors">
                What is an Idempotency Key?
              </h3>
              <p className="mt-4 text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
                Every request needs an{" "}
                <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-200/50 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                  Idempotency-Key
                </code>
                . It prevents double-charges if a network error causes a retry: if a request fails
                or times out, send the same request again with the same key and you get the same
                result — no duplicate charge.
              </p>
              <p className="mt-4 text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
                A key identifies one payment attempt, not one order. Generate a UUID per attempt and
                store it with the sessionId you get back. Keys are scoped to your account, so keys
                from other integrators never clash with yours, and a key can be at most 218
                characters. Reuse a key only to repeat a request that failed or timed out, with the
                same body, and never more than 24 hours after you first sent it. Generate a new key
                when the customer abandons checkout and starts again later, when the order changed,
                or after a 400 that says Stripe rejected a field. Each new key creates a new
                Checkout session, and starting again does not cancel the earlier one: it stays
                payable until it expires (24 hours by default), so the customer can still pay in the
                earlier tab. Add the new sessionId to the order's list and keep the earlier ones; do
                not replace them. Step 3 explains how to check all of them. Sending a key again for
                a different payment returns 409 IDEMPOTENCY_KEY_REUSED: use a new key.
              </p>
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Request Body
            </h3>
            <CodeBlock language="json">{`{
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
  "description": "Invoice #1234",
  "metadata": {
    "invoiceId": "1234",
    "customerName": "Jane Smith"
  }
}`}</CodeBlock>

            <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors shadow-sm">
              <table className="w-full text-sm text-slate-700 dark:text-slate-300 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Field
                    </th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Required
                    </th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Description
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      "lineItems",
                      "Yes",
                      "Non-empty array of items to charge — unit_amount is in cents (5000 = $50.00)",
                    ],
                    ["description", "No", "Shows up in your Stripe dashboard"],
                    ["metadata", "No", "Any key/value pairs you want attached to the payment"],
                  ].map(([field, req, desc]) => (
                    <tr
                      key={field}
                      className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]"
                    >
                      <td className="px-6 py-4 font-mono text-brand-600 dark:text-brand-300">
                        {field}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`text-[10px] font-black px-2 py-1 rounded-full transition-colors ${req === "Yes" ? "bg-brand-500/20 text-brand-600 dark:text-brand-400" : "bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400"}`}
                        >
                          {req.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs transition-colors">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Response
            </h3>
            <CodeBlock language="json">{`{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_..."
}`}</CodeBlock>
            <p className="mt-4 text-base text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              Save the{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                sessionId
              </code>{" "}
              against your own order right now, when you create the payment. You need it in Step 3
              to confirm the payment.
            </p>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Limits and retries
            </h3>
            <div className="grid gap-4">
              {[
                {
                  title: "A burst of 200 is admitted, but may need a retry.",
                  desc: "Many customers can pay at the same moment, for example when rent is due. Each account (the account behind your API key) can create 200 checkouts at once, and the allowance refills at 120 per minute (2 per second) as you use it. The portal's own limit admits a burst of 200, but only 25 Stripe calls run at a time and a request waits at most 10 seconds for its turn. When Stripe is slow, the tail of a large burst can run out of that time and get a 503 STRIPE_BUSY instead of a checkout, so build in the retry. The limit is a backstop against a runaway loop or a leaked key, not a throttle on normal traffic.",
                },
                {
                  title: "A refused request tells you when to retry.",
                  desc: 'A 429 with code "RATE_LIMITED" carries a Retry-After header: the whole number of seconds to wait (at least 1). Every 429 from this API carries both. You also get a 429 if Stripe itself is rate limiting the platform; then Retry-After is 2. A 503 with code "STRIPE_BUSY" and Retry-After: 5 means the platform is already making its maximum of 25 Stripe calls at once, and yours did not get its turn within 10 seconds (or too many requests were already waiting). Nothing was created.',
                },
                {
                  title: "Retry automatically, with the same Idempotency-Key.",
                  desc: "On a 429 or a 503, wait the Retry-After seconds plus a small random extra delay (for example up to one second, chosen separately for each request) and send the same request again with the same key, while your customer sees a waiting screen such as Preparing your payment. The customer should never have to click twice, and you should not generate a new key: a refused request created nothing, and a request that did get through is never created a second time under the same key. The random extra matters when many requests are refused together, as in a rent-day burst: if they all wait exactly the same time, they all come back at the same moment and are refused again. If the request is still refused after a few minutes of retries, stop and contact DFWSC support with the X-Request-Id.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] transition-all hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm"
                >
                  <h3 className="font-bold text-slate-900 dark:text-white text-base transition-colors">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Step 2 */}
          <section>
            <SectionAnchor id="step-2" />
            <SectionBadge>Frontend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Step 2 — Redirect to Checkout
            </h2>
            <p className="mt-4 text-lg text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              Send the customer&apos;s browser to the url from Step 1. Stripe hosts the payment form
              and handles PCI compliance — you never touch raw card numbers.
            </p>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Response from Step 1
            </h3>
            <CodeBlock language="json">{`{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_..."
}`}</CodeBlock>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Redirect the customer
            </h3>
            <CodeBlock language="javascript">{`// After your backend gets { url, sessionId } from Step 1:
window.location.href = url;`}</CodeBlock>

            <p className="mt-8 text-base text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              The customer completes payment on Stripe&apos;s hosted page and is then sent back to
              your configured success or cancel URL. On return to the success URL,{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                ?session_id=...
              </code>{" "}
              is appended (or{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                &amp;session_id=...
              </code>{" "}
              if your URL already has a query string), so you know which payment the customer is
              coming back from.
            </p>

            <div className="mt-8 p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] text-sm text-slate-700 dark:text-slate-300 transition-colors shadow-sm">
              <span className="font-bold text-slate-900 dark:text-white uppercase text-[10px] tracking-widest block mb-2 transition-colors">
                Pro Tip:
              </span>
              Ask your DFWSC administrator to configure your{" "}
              <strong>post-payment redirect URLs</strong> (success and cancel) so customers land
              back on the right pages of your site after checkout.
            </div>
          </section>

          {/* Step 3 */}
          <section>
            <SectionAnchor id="step-3" />
            <SectionBadge>Backend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Step 3 — Confirm the Payment
            </h2>
            <p className="mt-4 text-lg text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              Arriving on your success page does not prove the customer paid. Before you fulfil an
              order, check the payment from your{" "}
              <strong className="text-slate-900 dark:text-white underline decoration-brand-500/50 transition-colors">
                server
              </strong>{" "}
              using the{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                sessionId
              </code>{" "}
              you saved in Step 1 (every sessionId you saved, if the customer started checkout more
              than once for the order).
            </p>
            <p className="mt-4 text-base text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              Send your{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                X-Api-Key
              </code>{" "}
              header with this call. It is optional, but it changes the limit. With the key: up to
              600 requests per minute for your account, shared by every session you check, and you
              only see your own account&apos;s sessions (a session that belongs to another account
              returns 404, the same as an unknown session). A wrong or deactivated key returns 401;
              it is not treated as an anonymous call. Rejected keys are counted per calling IP
              address: after 30 of them in a minute, further calls from that address that send an
              X-Api-Key get a 429 with a Retry-After header until the minute has passed, without the
              key being checked. Successful calls are never counted, and a key that was checked
              successfully within the last minute is still served. Without it: the call is anonymous
              and limited to 30 requests per minute for each calling IP address, shared by
              everything calling from that address. This is the limit a customer&apos;s browser has
              when it loads the payment success page. Other errors: 400 for a sessionId that is not
              a Checkout session ID, and 404 for an unknown session. A 429 carries code RATE_LIMITED
              and a Retry-After header, as in Step 1.
            </p>

            <div className="mt-8 p-4 rounded-xl border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] font-mono text-brand-600 dark:text-brand-400 font-bold transition-colors">
              GET /api/v1/payments/session/{"{sessionId}"}
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Response
            </h3>
            <CodeBlock language="json">{`{
  "status": "paid",
  "baseAmountCents": 5000,
  "totalAmountCents": 5500,
  "feeAmountCents": 500,
  "currency": "usd",
  "createdAt": "2026-01-15T14:32:10.000Z"
}`}</CodeBlock>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6 transition-colors">
              Status values
            </h3>
            <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors shadow-sm">
              <table className="w-full text-sm text-slate-700 dark:text-slate-300 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Status
                    </th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Meaning
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {STATUS_ROWS.map((row) => (
                    <tr
                      key={row.status}
                      className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]"
                    >
                      <td className="px-6 py-4 font-mono text-brand-600 dark:text-brand-300">
                        {row.status}
                      </td>
                      <td className="px-6 py-4 text-xs transition-colors">{row.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-8 grid gap-4">
              {[
                {
                  title: "Fulfil only on paid.",
                  desc: "Compare baseAmountCents and currency to your order first. If they do not match, do not fulfil it.",
                },
                {
                  title: "Customers do not always come back.",
                  desc: "If someone pays and closes the tab, your success page never loads. Re-check any order that is still pending using its stored sessionId.",
                },
                {
                  title: "Check every session of an order, not just the newest.",
                  desc: "Starting checkout again does not cancel the earlier session, so it stays payable until it expires and the customer can still pay in an earlier tab. Check all of the order's stored sessionIds until each one is paid or expired. If an earlier session comes back paid, the order is paid: fulfil it once (if the amount matches, as above) and do not send the customer to pay again. If two sessions for the same order both come back paid, the customer paid twice: fulfil the order once and refund the extra payment from your Stripe dashboard, because this portal has no refund endpoint. If the order changed after an earlier session was created, that session still carries the old amount; a paid result whose amount no longer matches the order must not be fulfilled, and the payment needs to be reconciled or refunded in your Stripe dashboard.",
                },
                {
                  title: "Send your API key and back off when you poll.",
                  desc: "Sent with your X-Api-Key, this endpoint allows 600 requests per minute for your account, shared by every session you check; without the key it allows 30 requests per minute for each calling IP address. Check once when the customer lands on the success URL, then again after about 2, 5 and 10 seconds. If the status is still created, leave the order to a background job. Treat that job's polling as one budget shared by all your pending orders, not a rate per order: check a pending order once a minute for its first ten minutes, then every 15 minutes, and stop once the status is expired or 24 hours have passed since you created it (an abandoned checkout stays created until Stripe expires it). Keep the job's total to about 300 requests a minute across every order, so the check you make when a customer returns to the success URL always has headroom; if more orders are due than fit, check the oldest first and let the rest wait for the next minute. On a 429, wait the number of seconds in its Retry-After header, plus a small random extra delay, before the next attempt instead of retrying straight away.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] transition-all hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm"
                >
                  <h3 className="font-bold text-slate-900 dark:text-white text-base transition-colors">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Language Tabs & Examples */}
          <section>
            <SectionAnchor id="code-examples" />
            <SectionBadge>Examples</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Code Examples
            </h2>

            <div className="mt-8 flex flex-wrap gap-2">
              {LANG_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveLang(tab.id)}
                  className={`rounded-xl px-6 py-2.5 text-xs font-bold uppercase tracking-widest transition-all duration-200 cursor-pointer ${
                    activeLang === tab.id
                      ? "bg-brand-500 text-white shadow-glow"
                      : "bg-slate-100 dark:bg-white/[0.02] text-slate-500 border border-slate-200 dark:border-white/5 hover:bg-slate-200 dark:hover:bg-white/[0.08] hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeLangTab && (
              <CodeBlock language={activeLangTab.language}>{activeLangTab.code}</CodeBlock>
            )}
          </section>

          {/* Error Handling */}
          <section>
            <SectionAnchor id="error-handling" />
            <SectionBadge>Errors</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Error Handling
            </h2>
            <p className="mt-4 text-lg text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
              Errors return a JSON body with an{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                error
              </code>{" "}
              message. Most errors also include a{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                code
              </code>{" "}
              you can branch on. Every response carries an{" "}
              <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                X-Request-Id
              </code>{" "}
              header — log it and quote it when you contact support.
            </p>
            <CodeBlock language="json">{`{
  "error": "Description of what went wrong",
  "code": "ERROR_CODE",
  "requestId": "..."
}`}</CodeBlock>

            <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors shadow-sm">
              <table className="w-full text-sm text-slate-700 dark:text-slate-300 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Status
                    </th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Cause
                    </th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">
                      Retry?
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_ROWS.map((row) => (
                    <tr
                      key={row.cause}
                      className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]"
                    >
                      <td className="px-6 py-4 font-black text-slate-900 dark:text-white transition-colors">
                        {row.status}
                      </td>
                      <td className="px-6 py-4 text-slate-600 dark:text-slate-300 transition-colors">
                        {row.cause}
                      </td>
                      <td className="px-6 py-4 text-xs transition-colors">{row.retry}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-6 text-sm text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
              A 502 or 503 returned while the API restarts during a deploy comes from the proxy in
              front of it, so it has neither this JSON body nor the X-Request-Id header. Check the
              status code before you parse the body.
            </p>
          </section>

          {/* Rules */}
          <section>
            <SectionAnchor id="rules" />
            <SectionBadge>Rules</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">
              Rules to Follow
            </h2>
            <div className="mt-8 grid gap-4">
              {[
                {
                  title: "Your API key goes on your backend only.",
                  desc: "Never put it in frontend JavaScript or a mobile app binary.",
                },
                {
                  title: "Always use a new Idempotency-Key (a UUID) per payment attempt.",
                  desc: "A key covers one attempt, not one order. Store it with the sessionId, reuse it only to retry a failed or timed-out request within 24 hours, and generate a new one when the customer starts checkout again. Keep every sessionId you create for an order: an earlier session stays payable until it expires.",
                },
                {
                  title: "Retry 429 and 503 automatically.",
                  desc: "Wait the Retry-After seconds plus a small random extra delay, then send the same request with the same Idempotency-Key, and show the customer a waiting screen so they never have to click twice.",
                },
                {
                  title: "Amounts are in cents.",
                  desc: "$1.00 = 100, $25.50 = 2550, $100.00 = 10000.",
                },
                { title: "Use HTTPS.", desc: "Never send your API key over plain HTTP." },
              ].map((rule) => (
                <div
                  key={rule.title}
                  className="p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] transition-all hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm"
                >
                  <h3 className="font-bold text-slate-900 dark:text-white text-base transition-colors">
                    {rule.title}
                  </h3>
                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
                    {rule.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Final Call to Action */}
          <section className="pt-12 border-t border-slate-200 dark:border-white/5 transition-colors">
            <SectionAnchor id="need-help" />
            <div className="rounded-[2.5rem] bg-gradient-to-br from-brand-600/5 to-transparent dark:from-brand-600/20 dark:to-transparent border border-slate-200 dark:border-white/5 p-12 text-center shadow-sm">
              <h2 className="text-3xl font-bold text-slate-900 dark:text-white transition-colors">
                Need custom integration help?
              </h2>
              <p className="mt-6 text-lg text-slate-700 dark:text-slate-300 max-w-2xl mx-auto transition-colors">
                Our engineers are available for embedded support, custom API builds, and
                architecture reviews. Let&apos;s talk about your next milestone.
              </p>
              <Link
                to="/"
                state={{ scrollTo: "contact" }}
                className="mt-10 inline-flex items-center justify-center rounded-full bg-brand-500 px-10 py-4 text-base font-bold text-white shadow-glow transition-all duration-300 hover:shadow-glow-strong hover:-translate-y-1"
              >
                Get in touch
              </Link>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
