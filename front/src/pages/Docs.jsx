import { useState } from "react";
import { Link } from "react-router-dom";

const sidebarSections = [
  { id: "what-you-have", label: "What You Have" },
  { id: "how-it-works", label: "How It Works" },
  { id: "quick-start", label: "Quick Start" },
  { id: "step-1", label: "Step 1 — Create a Payment" },
  { id: "step-2", label: "Step 2 — Show the Payment Form" },
  { id: "code-examples", label: "Code Examples" },
  { id: "error-handling", label: "Error Handling" },
  { id: "rules", label: "Rules" },
  { id: "need-help", label: "Need Help?" },
];

function CodeBlock({ children, language }) {
  return (
    <div className="relative group my-6">
      <div className="absolute -inset-px rounded-xl bg-gradient-to-r from-brand-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <pre className="relative rounded-xl border border-white/5 bg-black/40 backdrop-blur-sm overflow-x-auto p-5 font-mono text-sm text-slate-300 leading-relaxed shadow-2xl">
        {language && (
          <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-500">
              {language}
            </span>
            <div className="flex gap-1.5">
              <div className="h-2 w-2 rounded-full bg-white/10" />
              <div className="h-2 w-2 rounded-full bg-white/10" />
              <div className="h-2 w-2 rounded-full bg-white/10" />
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
    <span className="inline-flex items-center rounded-full border border-brand-500/20 bg-brand-500/5 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-brand-400">
      {children}
    </span>
  );
}

function SectionAnchor({ id }) {
  return <span id={id} className="-mt-24 block pt-24" aria-hidden="true" />;
}

const NODE_CODE = `const { randomUUID } = require('crypto');

async function createPayment(amountCents, description) {
  const response = await fetch(
    'https://<your-api-base-url>/api/v1/payments/create',
    {
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
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(\`Payment error: \${err.error}\`);
  }

  return response.json(); // { clientSecret, paymentIntentId }
}`;

const PYTHON_CODE = `import requests
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
    return response.json()  # { 'clientSecret': ..., 'paymentIntentId': ... }`;

const PHP_CODE = `function createPayment(int $amountCents, string $description): array {
    $ch = curl_init(
        'https://<your-api-base-url>/api/v1/payments/create'
    );
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
    return json_decode($result, true);
    // ['clientSecret' => ..., 'paymentIntentId' => ...]
}`;

const LANG_TABS = [
  { id: "node", label: "Node.js", code: NODE_CODE, language: "javascript" },
  { id: "python", label: "Python", code: PYTHON_CODE, language: "python" },
  { id: "php", label: "PHP", code: PHP_CODE, language: "php" },
];

const ERROR_ROWS = [
  {
    status: "400",
    cause: "Missing or invalid field",
    fix: "Check request body — the error message says what's wrong",
  },
  { status: "401", cause: "Bad or missing API key", fix: "Verify your X-Api-Key header" },
  { status: "429", cause: "Too many requests", fix: "Slow down and retry" },
  { status: "500", cause: "Server error", fix: "Contact DFWSC support" },
  { status: "502", cause: "Stripe unreachable", fix: "Retry — usually temporary" },
];

export default function Docs() {
  const [activeLang, setActiveLang] = useState("node");

  const handleSidebarClick = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  const activeLangTab = LANG_TABS.find((t) => t.id === activeLang);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8 sm:py-24">
      {/* Page header */}
      <div className="mb-20">
        <SectionBadge>Developer Reference</SectionBadge>
        <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-white sm:text-6xl text-gradient">
          Connect Your App
        </h1>
        <p className="mt-8 max-w-2xl text-xl text-slate-400 leading-relaxed">
          Everything you need to accept payments through the DFWSC platform — from your backend
          server to your customer-facing checkout form.
        </p>
        <div className="mt-8 flex items-center gap-2 text-sm text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
          Prerequisites: you have already been onboarded and received your API key. 
          If not, {" "}
          <Link
            to="/"
            state={{ scrollTo: "contact" }}
            className="text-brand-400 font-bold hover:text-brand-300 transition-colors"
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
            <h3 className="px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-600 mb-4">On this page</h3>
            {sidebarSections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleSidebarClick(s.id)}
                className="group flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-400 transition-all duration-200 hover:bg-white/[0.03] hover:text-white cursor-pointer"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-transparent group-hover:bg-brand-500 mr-3 transition-colors" />
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Mobile sidebar — horizontal pill list */}
        <div className="lg:hidden -mx-4 mb-12 flex gap-3 overflow-x-auto px-4 pb-4 border-b border-white/5">
          {sidebarSections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => handleSidebarClick(s.id)}
              className="flex-none rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2 text-xs font-bold text-slate-400 transition hover:bg-white/[0.08] hover:text-white cursor-pointer whitespace-nowrap uppercase tracking-widest"
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
            <h2 className="mt-4 text-3xl font-bold text-white">What You Have</h2>
            <p className="mt-4 text-lg text-slate-400">After onboarding you should have received:</p>
            <div className="mt-8 grid gap-4">
              {[
                { label: "API Key", desc: "A long string of letters and numbers. Authenticates every request. Keep it secret — treat it like a password and never expose it in frontend code." },
                { label: "API Base URL", desc: "The address of the payment server (e.g., https://api.yourdfwscportal.com)." }
              ].map((item) => (
                <div key={item.label} className="p-6 rounded-2xl border border-white/5 bg-white/[0.01] transition-all hover:bg-white/[0.03]">
                  <h3 className="font-bold text-white text-lg">{item.label}</h3>
                  <p className="mt-2 text-sm text-slate-400 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* How It Works */}
          <section>
            <SectionAnchor id="how-it-works" />
            <SectionBadge>Overview</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-white">How It Works</h2>
            <div className="mt-8 space-y-6">
              {[
                <>
                  Your backend calls the DFWSC API with the payment amount — it returns a{" "}
                  <code className="rounded-lg bg-white/5 px-2 py-1 text-brand-300 font-mono">
                    clientSecret
                  </code>
                  .
                </>,
                <>
                  Your frontend uses Stripe.js with that{" "}
                  <code className="rounded-lg bg-white/5 px-2 py-1 text-brand-300 font-mono">
                    clientSecret
                  </code>{" "}
                  to show a payment form.
                </>,
                "The customer fills in their card and submits — Stripe handles the actual charge.",
                "You get a webhook or redirect when the payment succeeds.",
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-6 group">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-500/20 bg-brand-500/5 text-sm font-black text-brand-400 group-hover:bg-brand-500 group-hover:text-white transition-all">
                    {i + 1}
                  </span>
                  <div className="pt-2 text-base text-slate-300 leading-relaxed">{step}</div>
                </div>
              ))}
            </div>
            <div className="mt-10 p-6 rounded-2xl border border-brand-500/10 bg-brand-500/5 text-brand-200 font-bold text-center">
              Your customers never leave your site.
            </div>
          </section>

          {/* Quick Start */}
          <section>
            <SectionAnchor id="quick-start" />
            <SectionBadge>Quick Start</SectionBadge>
            <h2 className="mt-3 text-2xl font-bold text-white">Test Your API Key</h2>
            <p className="mt-3 text-sm text-slate-300">
              Run this curl command to confirm your key works. A{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">clientSecret</code>{" "}
              in the response means you&apos;re good. A{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">401</code> means
              your API key is wrong.
            </p>
            <div className="mt-4">
              <CodeBlock language="bash">{`curl -X POST https://<your-api-base-url>/api/v1/payments/create \\
  -H "X-Api-Key: <your-api-key>" \\
  -H "Idempotency-Key: test-001" \\
  -H "Content-Type: application/json" \\
  -d '{ "amount": 100, "currency": "usd" }'`}</CodeBlock>
            </div>
          </section>

          {/* Step 1 */}
          <section>
            <SectionAnchor id="step-1" />
            <SectionBadge>Backend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-white">Step 1 — Create a Payment</h2>
            <p className="mt-4 text-lg text-slate-400 leading-relaxed">
              Call this from your <strong className="text-white underline decoration-brand-500/50">server</strong>, never from the browser.
            </p>
            
            <div className="mt-8 p-4 rounded-xl border border-white/5 bg-white/[0.02] font-mono text-brand-400 font-bold">
              POST /api/v1/payments/create
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-6">Required Headers</h3>
            <div className="overflow-hidden rounded-2xl border border-white/5 bg-white/[0.01]">
              <table className="w-full text-sm text-slate-400">
                <thead>
                  <tr className="border-b border-white/5 bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-white uppercase tracking-widest text-[10px]">Header</th>
                    <th className="px-6 py-4 text-left font-bold text-white uppercase tracking-widest text-[10px]">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["X-Api-Key", "Your API key"],
                    ["Idempotency-Key", "A unique string for this payment attempt"],
                    ["Content-Type", "application/json"],
                  ].map(([header, value]) => (
                    <tr key={header} className="border-b border-white/5 last:border-0 transition-colors hover:bg-white/[0.02]">
                      <td className="px-6 py-4 font-mono text-brand-300">{header}</td>
                      <td className="px-6 py-4">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-12 p-8 rounded-[2rem] border border-white/5 bg-white/[0.02]">
              <h3 className="text-xl font-bold text-white">What is an Idempotency Key?</h3>
              <p className="mt-4 text-slate-400 leading-relaxed">
                Every request needs a unique <code className="text-brand-300 font-mono bg-white/5 px-1.5 py-0.5 rounded">Idempotency-Key</code>. 
                It prevents double-charges if a network error causes a retry. If you send the same key twice, 
                the second request returns the same result — no duplicate charge.
              </p>
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-6">Request Body</h3>
            <CodeBlock language="json">{`{
  "amount": 5000,
  "currency": "usd",
  "description": "Invoice #1234",
  "metadata": {
    "invoiceId": "1234",
    "customerName": "Jane Smith"
  }
}`}</CodeBlock>

            <div className="mt-8 overflow-hidden rounded-2xl border border-white/5 bg-white/[0.01]">
              <table className="w-full text-sm text-slate-400">
                <thead>
                  <tr className="border-b border-white/5 bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-white uppercase tracking-widest text-[10px]">Field</th>
                    <th className="px-6 py-4 text-left font-bold text-white uppercase tracking-widest text-[10px]">Required</th>
                    <th className="px-6 py-4 text-left font-bold text-white uppercase tracking-widest text-[10px]">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["amount", "Yes", "Amount in cents — 5000 = $50.00"],
                    ["currency", "Yes", '3-letter currency code, e.g. "usd"'],
                    ["description", "No", "Shows up in your Stripe dashboard"],
                    ["metadata", "No", "Any key/value pairs you want attached to the payment"],
                  ].map(([field, req, desc]) => (
                    <tr key={field} className="border-b border-white/5 last:border-0 transition-colors hover:bg-white/[0.02]">
                      <td className="px-6 py-4 font-mono text-brand-300">{field}</td>
                      <td className="px-6 py-4">
                        <span className={`text-[10px] font-black px-2 py-1 rounded-full ${req === "Yes" ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-500"}`}>
                          {req.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-6">Response</h3>
            <CodeBlock language="json">{`{
  "clientSecret": "pi_3OxyzABC_secret_def456",
  "paymentIntentId": "pi_3OxyzABC"
}`}</CodeBlock>
            <p className="mt-4 text-sm text-slate-400">
              Pass the{" "}
              <code className="text-brand-300 font-mono bg-white/5 px-1.5 py-0.5 rounded">clientSecret</code>{" "}
              to your frontend — do not log or store it.
            </p>
          </section>

          {/* Step 2 */}
          <section>
            <SectionAnchor id="step-2" />
            <SectionBadge>Frontend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-white">Step 2 — Show the Payment Form</h2>
            <p className="mt-4 text-lg text-slate-400 leading-relaxed">
              Use Stripe.js to collect and submit the card. Stripe handles PCI compliance — you
              never touch raw card numbers.
            </p>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-6">Add Stripe.js to your page</h3>
            <CodeBlock language="html">{`<script src="https://js.stripe.com/v3/"></script>`}</CodeBlock>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-6">Mount the payment form</h3>
            <div className="space-y-4">
              <CodeBlock language="javascript">{`const stripe = Stripe('<your-stripe-publishable-key>');

// clientSecret comes from your backend (Step 1)
const elements = stripe.elements({ clientSecret });

const paymentElement = elements.create('payment');
paymentElement.mount('#payment-element');`}</CodeBlock>
              <CodeBlock language="html">{`<form id="payment-form">
  <div id="payment-element"></div>
  <button type="submit">Pay Now</button>
  <div id="error-message"></div>
</form>`}</CodeBlock>
            </div>

            <h3 className="mt-8 text-lg font-semibold text-white">Handle form submission</h3>
            <div className="mt-3">
              <CodeBlock language="javascript">{`document.getElementById('payment-form')
  .addEventListener('submit', async (e) => {
    e.preventDefault();

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: 'https://yoursite.com/payment-complete',
      },
    });

    if (error) {
      document.getElementById('error-message').textContent =
        error.message;
    }
    // On success, Stripe redirects to return_url automatically
  });`}</CodeBlock>
            </div>
            <p className="mt-4 text-sm text-slate-300">
              After successful payment, Stripe redirects the customer to your{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">return_url</code>{" "}
              with the payment status in the query string.
            </p>
            <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/50 p-4 text-sm text-slate-300">
              <span className="font-semibold text-white">Note: </span>Your{" "}
              <strong>Stripe publishable key</strong> (
              <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">pk_live_...</code>{" "}
              or{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">pk_test_...</code>)
              is different from your DFWSC API key. Find it in your Stripe dashboard under
              Developers &gt; API keys.
            </div>
          </section>

          {/* Code Examples */}
          <section>
            <SectionAnchor id="code-examples" />
            <SectionBadge>Examples</SectionBadge>
            <h2 className="mt-3 text-2xl font-bold text-white">Code Examples (Backend)</h2>
            <p className="mt-3 text-sm text-slate-300">
              Full backend examples for creating a payment intent.
            </p>

            {/* Language tabs */}
            <div className="mt-6 flex gap-2">
              {LANG_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveLang(tab.id)}
                  className={`rounded-full border px-4 py-1.5 text-sm font-medium transition duration-150 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                    activeLang === tab.id
                      ? "border-brand-500/60 bg-brand-500/20 text-brand-200"
                      : "border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:text-white"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {activeLangTab && (
                <CodeBlock language={activeLangTab.language}>{activeLangTab.code}</CodeBlock>
              )}
            </div>
          </section>

          {/* Error Handling */}
          <section>
            <SectionAnchor id="error-handling" />
            <SectionBadge>Errors</SectionBadge>
            <h2 className="mt-3 text-2xl font-bold text-white">Error Handling</h2>
            <p className="mt-3 text-sm text-slate-300">
              Errors return a JSON body with an{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">error</code> field:
            </p>
            <div className="mt-4">
              <CodeBlock language="json">{`{ "error": "Description of what went wrong" }`}</CodeBlock>
            </div>
            <div className="mt-6 overflow-hidden rounded-xl border border-white/10">
              <table className="w-full text-sm text-slate-300">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900/60">
                    <th className="px-4 py-3 text-left font-semibold text-white">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-white">Cause</th>
                    <th className="px-4 py-3 text-left font-semibold text-white">Fix</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_ROWS.map((row) => (
                    <tr
                      key={row.status}
                      className="border-b border-white/10 last:border-0 hover:bg-white/5"
                    >
                      <td className="px-4 py-3">
                        <code className="rounded bg-slate-800 px-1.5 py-0.5 font-bold text-slate-200">
                          {row.status}
                        </code>
                      </td>
                      <td className="px-4 py-3">{row.cause}</td>
                      <td className="px-4 py-3">{row.fix}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Rules */}
          <section>
            <SectionAnchor id="rules" />
            <SectionBadge>Rules</SectionBadge>
            <h2 className="mt-3 text-2xl font-bold text-white">Rules to Follow</h2>
            <ul className="mt-4 space-y-4 text-sm text-slate-300">
              {[
                <>
                  <strong className="text-white">Your API key goes on your backend only.</strong>{" "}
                  Never put it in frontend JavaScript or a mobile app binary.
                </>,
                <>
                  <strong className="text-white">
                    Always use a unique{" "}
                    <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">
                      Idempotency-Key
                    </code>{" "}
                    per payment attempt.
                  </strong>{" "}
                  Your invoice or order ID works great.
                </>,
                <>
                  <strong className="text-white">Amounts are in cents.</strong> $1.00 ={" "}
                  <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">100</code>,
                  $25.50 ={" "}
                  <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">2550</code>,
                  $100.00 ={" "}
                  <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">10000</code>.
                </>,
                <>
                  <strong className="text-white">Use HTTPS.</strong> Never send your API key over
                  plain HTTP.
                </>,
              ].map((rule, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static inline array, never reorders
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 flex-none rounded-full bg-brand-400" />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Need Help */}
          <section>
            <SectionAnchor id="need-help" />
            <SectionBadge>Support</SectionBadge>
            <h2 className="mt-3 text-2xl font-bold text-white">Need Help?</h2>
            <p className="mt-3 text-sm text-slate-300">Contact your DFWSC administrator if:</p>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              {[
                "Your API key needs to be re-issued",
                "You're getting consistent 401 or 502 errors",
                "You need to update your post-payment redirect URL",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 flex-none rounded-full bg-brand-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8 rounded-2xl border border-white/10 bg-slate-900/50 p-6">
              <p className="text-sm text-slate-300">
                Ready to get started or have a question about your integration?
              </p>
              <Link
                to="/"
                state={{ scrollTo: "contact" }}
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
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
