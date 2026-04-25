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
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8 sm:py-24 transition-colors duration-300">
      {/* Page header */}
      <div className="mb-20">
        <SectionBadge>Developer Reference</SectionBadge>
        <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-6xl text-gradient transition-colors">
          Connect Your App
        </h1>
        <p className="mt-8 max-w-2xl text-xl text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
          Everything you need to accept payments through the DFWSC platform — from your backend
          server to your customer-facing checkout form.
        </p>
        <div className="mt-8 flex items-center gap-2 text-sm text-slate-500 transition-colors">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
          Prerequisites: you have already been onboarded and received your API key. 
          If not, {" "}
          <Link
            to="/"
            state={{ scrollTo: "contact" }}
            className="text-brand-500 dark:text-brand-400 font-bold hover:text-brand-600 dark:hover:text-brand-300 transition-colors"
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
            <h3 className="px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 dark:text-slate-600 mb-4 transition-colors">On this page</h3>
            {sidebarSections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleSidebarClick(s.id)}
                className="group flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-500 dark:text-slate-400 transition-all duration-200 hover:bg-slate-100 dark:hover:bg-white/[0.03] hover:text-brand-600 dark:hover:text-white cursor-pointer"
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
              className="flex-none rounded-xl border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] px-4 py-2 text-xs font-bold text-slate-500 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-slate-900 dark:hover:text-white cursor-pointer whitespace-nowrap uppercase tracking-widest"
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
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">What You Have</h2>
            <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 transition-colors">After onboarding you should have received:</p>
            <div className="mt-8 grid gap-4">
              {[
                { label: "API Key", desc: "A long string of letters and numbers. Authenticates every request. Keep it secret — treat it like a password and never expose it in frontend code." },
                { label: "API Base URL", desc: "The address of the payment server (e.g., https://api.yourdfwscportal.com)." }
              ].map((item) => (
                <div key={item.label} className="p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] transition-all hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm">
                  <h3 className="font-bold text-slate-900 dark:text-white text-lg transition-colors">{item.label}</h3>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">{item.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* How It Works */}
          <section>
            <SectionAnchor id="how-it-works" />
            <SectionBadge>Overview</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">How It Works</h2>
            <div className="mt-8 space-y-6">
              {[
                <>
                  Your backend calls the DFWSC API with the payment amount — it returns a{" "}
                  <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                    clientSecret
                  </code>
                  .
                </>,
                <>
                  Your frontend uses Stripe.js with that{" "}
                  <code className="rounded-lg bg-slate-100 dark:bg-white/5 px-2 py-1 text-brand-600 dark:text-brand-300 font-mono transition-colors">
                    clientSecret
                  </code>{" "}
                  to show a payment form.
                </>,
                "The customer fills in their card and submits — Stripe handles the actual charge.",
                "You get a webhook or redirect when the payment succeeds.",
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-6 group">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-500/20 bg-brand-500/5 text-sm font-black text-brand-600 dark:text-brand-400 group-hover:bg-brand-500 group-hover:text-white transition-all">
                    {i + 1}
                  </span>
                  <div className="pt-2 text-base text-slate-600 dark:text-slate-300 leading-relaxed transition-colors">{step}</div>
                </div>
              ))}
            </div>
            <div className="mt-10 p-6 rounded-2xl border border-brand-500/10 bg-brand-500/5 text-brand-600 dark:text-brand-200 font-bold text-center transition-colors">
              Your customers never leave your site.
            </div>
          </section>

          {/* Quick Start */}
          <section>
            <SectionAnchor id="quick-start" />
            <SectionBadge>Quick Start</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">Test Your API Key</h2>
            <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 transition-colors">
              Run this curl command to confirm your key works. A successful response includes a clientSecret.
            </p>
            <CodeBlock language="bash">{`curl -X POST https://<your-api-base-url>/api/v1/payments/create \\
  -H "X-Api-Key: <your-api-key>" \\
  -H "Idempotency-Key: test-001" \\
  -H "Content-Type: application/json" \\
  -d '{ "amount": 100, "currency": "usd" }'`}</CodeBlock>
          </section>

          {/* Step 1 */}
          <section>
            <SectionAnchor id="step-1" />
            <SectionBadge>Backend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">Step 1 — Create a Payment</h2>
            <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
              Call this from your <strong className="text-slate-900 dark:text-white underline decoration-brand-500/50 transition-colors">server</strong>, never from the browser.
            </p>
            
            <div className="mt-8 p-4 rounded-xl border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] font-mono text-brand-600 dark:text-brand-400 font-bold transition-colors">
              POST /api/v1/payments/create
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-6 transition-colors">Required Headers</h3>
            <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors">
              <table className="w-full text-sm text-slate-600 dark:text-slate-400 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Header</th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["X-Api-Key", "Your API key"],
                    ["Idempotency-Key", "A unique string for this payment attempt"],
                    ["Content-Type", "application/json"],
                  ].map(([header, value]) => (
                    <tr key={header} className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                      <td className="px-6 py-4 font-mono text-brand-600 dark:text-brand-300">{header}</td>
                      <td className="px-6 py-4">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-12 p-8 rounded-[2rem] border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] transition-colors">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white transition-colors">What is an Idempotency Key?</h3>
              <p className="mt-4 text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
                Every request needs a unique <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-200/50 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">Idempotency-Key</code>. 
                It prevents double-charges if a network error causes a retry. If you send the same key twice, 
                the second request returns the same result — no duplicate charge.
              </p>
            </div>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-6 transition-colors">Request Body</h3>
            <CodeBlock language="json">{`{
  "amount": 5000,
  "currency": "usd",
  "description": "Invoice #1234",
  "metadata": {
    "invoiceId": "1234",
    "customerName": "Jane Smith"
  }
}`}</CodeBlock>

            <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors shadow-sm">
              <table className="w-full text-sm text-slate-600 dark:text-slate-400 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Field</th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Required</th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["amount", "Yes", "Amount in cents — 5000 = $50.00"],
                    ["currency", "Yes", '3-letter currency code, e.g. "usd"'],
                    ["description", "No", "Shows up in your Stripe dashboard"],
                    ["metadata", "No", "Any key/value pairs you want attached to the payment"],
                  ].map(([field, req, desc]) => (
                    <tr key={field} className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                      <td className="px-6 py-4 font-mono text-brand-600 dark:text-brand-300">{field}</td>
                      <td className="px-6 py-4">
                        <span className={`text-[10px] font-black px-2 py-1 rounded-full transition-colors ${req === "Yes" ? "bg-brand-500/20 text-brand-600 dark:text-brand-400" : "bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-slate-500"}`}>
                          {req.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs transition-colors">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Step 2 */}
          <section>
            <SectionAnchor id="step-2" />
            <SectionBadge>Frontend</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">Step 2 — Show the Payment Form</h2>
            <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
              Use Stripe.js to collect and submit the card. Stripe handles PCI compliance — you
              never touch raw card numbers.
            </p>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-6 transition-colors">Add Stripe.js to your page</h3>
            <CodeBlock language="html">{`<script src="https://js.stripe.com/v3/"></script>`}</CodeBlock>

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-6 transition-colors">Mount the payment form</h3>
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

            <h3 className="mt-12 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-6 transition-colors">Handle form submission</h3>
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
  });`}</CodeBlock>
            
            <div className="mt-8 p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] text-sm text-slate-600 dark:text-slate-400 transition-colors shadow-sm">
              <span className="font-bold text-slate-900 dark:text-white uppercase text-[10px] tracking-widest block mb-2 transition-colors">Pro Tip:</span>
              Your <strong>Stripe publishable key</strong> (pk_live_... or pk_test_...) 
              is different from your DFWSC API key. Find it in your Stripe dashboard under 
              Developers &gt; API keys.
            </div>
          </section>

          {/* Language Tabs & Examples */}
          <section>
            <SectionAnchor id="code-examples" />
            <SectionBadge>Examples</SectionBadge>
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">Code Examples</h2>
            
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
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">Error Handling</h2>
            <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
              Errors return a JSON body with an <code className="text-brand-600 dark:text-brand-300 font-mono bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded transition-colors">error</code> field.
            </p>
            <CodeBlock language="json">{`{ "error": "Description of what went wrong" }`}</CodeBlock>
            
            <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.01] transition-colors shadow-sm">
              <table className="w-full text-sm text-slate-600 dark:text-slate-400 transition-colors">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02]">
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Status</th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Cause</th>
                    <th className="px-6 py-4 text-left font-bold text-slate-900 dark:text-white uppercase tracking-widest text-[10px] transition-colors">Fix</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_ROWS.map((row) => (
                    <tr key={row.status} className="border-b border-slate-100 dark:border-white/5 last:border-0 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                      <td className="px-6 py-4 font-black text-slate-900 dark:text-white transition-colors">{row.status}</td>
                      <td className="px-6 py-4 text-slate-600 dark:text-slate-300 transition-colors">{row.cause}</td>
                      <td className="px-6 py-4 text-xs transition-colors">{row.fix}</td>
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
            <h2 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white transition-colors">Rules to Follow</h2>
            <div className="mt-8 grid gap-4">
              {[
                { title: "Your API key goes on your backend only.", desc: "Never put it in frontend JavaScript or a mobile app binary." },
                { title: "Always use a unique Idempotency-Key per payment attempt.", desc: "Your invoice or order ID works great." },
                { title: "Amounts are in cents.", desc: "$1.00 = 100, $25.50 = 2550, $100.00 = 10000." },
                { title: "Use HTTPS.", desc: "Never send your API key over plain HTTP." }
              ].map((rule) => (
                <div key={rule.title} className="p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.01] transition-all hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm">
                  <h3 className="font-bold text-slate-900 dark:text-white text-base transition-colors">{rule.title}</h3>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">{rule.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Final Call to Action */}
          <section className="pt-12 border-t border-slate-200 dark:border-white/5 transition-colors">
            <SectionAnchor id="need-help" />
            <div className="rounded-[2.5rem] bg-gradient-to-br from-brand-600/5 to-transparent dark:from-brand-600/20 dark:to-transparent border border-slate-200 dark:border-white/5 p-12 text-center shadow-sm">
              <h2 className="text-3xl font-bold text-slate-900 dark:text-white transition-colors">Need custom integration help?</h2>
              <p className="mt-6 text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto transition-colors">
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
