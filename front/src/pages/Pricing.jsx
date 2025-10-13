import { Link } from 'react-router-dom'

const plans = [
  {
    name: 'Starter Hosting',
    price: '$10 / mo',
    alt: 'or $50 / yr',
    includes: 'Static landing page hosting, SSL, CDN, domain setup',
    idealFor: 'Portfolios, promo pages',
  },
  {
    name: 'Basic Hosting',
    price: '$25 / mo',
    includes: 'Hosting + uptime monitoring, minor edits, payment setup',
    idealFor: 'Small business sites',
  },
  {
    name: 'Standard Hosting',
    price: '$75 / mo',
    includes: 'Maintenance, backups, domain management',
    idealFor: 'Multi-page business sites',
  },
  {
    name: 'Pro Hosting',
    price: '$100 / mo',
    includes: 'Database & backend hosting, monitoring',
    idealFor: 'Full-stack apps',
  },
  {
    name: 'Enterprise Hosting',
    price: '$200+ / mo',
    includes: 'Dedicated infrastructure, analytics, SLA uptime',
    idealFor: 'Production-critical systems',
  },
  {
    name: 'Private Network Hosting',
    price: '$20 / mo',
    includes: 'Local hosting on DFWSC-managed servers (DFW area only)',
    idealFor: 'Brick-and-mortar businesses',
  },
]

export default function Pricing() {
  return (
    <div className="container-px section-y space-y-16">
      <section className="mx-auto max-w-4xl text-center">
        <span className="badge mb-6">Hosting & Maintenance</span>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
          Predictable pricing for platforms you can depend on
        </h1>
        <p className="mt-6 text-lg text-slate-300">
          Every plan includes SSL, global CDN delivery, and DFWSC-managed updates so you can focus on customers.
        </p>
        <p className="mt-4 text-sm text-slate-400">
          Backend features, integrations, and new development are scoped separately and billed hourly ($100–$150/hr).
        </p>
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/50 shadow-xl shadow-cyan-500/10">
        <div className="grid divide-y divide-white/5 text-left sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {plans.map((plan) => (
            <article key={plan.name} className="p-8">
              <h2 className="text-xl font-semibold text-white">{plan.name}</h2>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-3xl font-bold text-brand-300">{plan.price}</span>
                {plan.alt ? <span className="text-sm text-slate-400">{plan.alt}</span> : null}
              </div>
              <p className="mt-6 text-sm text-slate-300">{plan.includes}</p>
              <p className="mt-3 text-xs uppercase tracking-wide text-slate-400">Ideal for: {plan.idealFor}</p>
            </article>
          ))}
        </div>
        <div className="border-t border-white/5 bg-slate-900/60 p-6 text-sm text-slate-300 sm:text-base">
          All hosting plans are non-taxable professional services in Texas and include DFWSC-managed uptime, SSL, monitoring,
          and incident response.
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="card p-8">
          <h2 className="text-2xl font-semibold text-white">Project Kickoffs</h2>
          <p className="mt-3 text-sm text-slate-300">
            Need a new build or major feature? We start with a short discovery workshop to define scope, handoff plan, and
            success metrics. You&apos;ll get a written proposal with milestone pricing before any code is written.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-slate-200">
            <li className="flex items-start gap-3">
              <span className="mt-1 h-2.5 w-2.5 flex-none rounded-full bg-brand-400" />
              <span>2–6 week MVP timelines with weekly previews and async updates.</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-1 h-2.5 w-2.5 flex-none rounded-full bg-brand-400" />
              <span>Clear documentation so you can run in-house or keep us on retainer.</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-1 h-2.5 w-2.5 flex-none rounded-full bg-brand-400" />
              <span>Integrations with Stripe, CRMs, and analytics platforms baked in.</span>
            </li>
          </ul>
        </div>
        <div className="card flex flex-col justify-between p-8">
          <div>
            <h2 className="text-2xl font-semibold text-white">Let&apos;s pick the right plan</h2>
            <p className="mt-3 text-sm text-slate-300">
              Tell us about the app, traffic expectations, and compliance needs. We&apos;ll recommend an environment and share a
              migration path if you&apos;re moving from an existing host.
            </p>
          </div>
          <Link to="/" state={{ scrollTo: 'contact' }} className="btn-primary mt-8 w-fit">
            Start the conversation
          </Link>
        </div>
      </section>
    </div>
  )
}
