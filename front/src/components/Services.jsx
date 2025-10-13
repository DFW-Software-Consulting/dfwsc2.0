const services = [
  {
    name: 'Custom Web Apps',
    description: 'Dashboards, portals, and internal tools with UX that keeps ops moving fast.',
    details: ['Design systems in React/Next.js', 'Role-based access, audit trails', 'Performance budgets & accessibility'],
  },
  {
    name: 'E-commerce & Payments',
    description: 'Subscriptions, checkout flows, and secure payment integrations that just work.',
    details: ['Stripe, LemonSqueezy, ACH', 'Inventory, tax, and fulfillment workflows', 'Multi-step onboarding & verifications'],
  },
  {
    name: 'APIs & Integrations',
    description: 'REST & GraphQL services, webhooks, and data sync built for reliability.',
    details: ['Postgres, Redis, Prisma/Drizzle', 'Third-party integrations & webhooks', 'Monitoring, logging, and alerting'],
  },
  {
    name: 'Video & File Delivery',
    description: 'Streaming, secure downloads, and presigned links with analytics included.',
    details: ['Cloudflare Stream & R2', 'Bunny.net, AWS S3', 'Access control & DRM-friendly setups'],
  },
  {
    name: 'AI-assisted Workflows',
    description: 'Practical automation for data extraction, QA, and internal enablement.',
    details: ['LLM integrations & prompt libraries', 'Ollama for secure on-prem inference', 'Agentic scripts for docs & testing'],
  },
  {
    name: 'Cloud Infrastructure',
    description: 'Deployments, monitoring, and cost-aware scaling across modern platforms.',
    details: ['Cloudflare Workers, AWS, Render', 'IaC, CI/CD, and observability', 'On-call and incident response playbooks'],
  },
]

export default function Services() {
  return (
    <section id="services" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">What we do</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Full-stack product delivery without the hand-holding</h2>
        <p className="mt-4 text-base text-slate-300">
          From prototypes to production-critical systems, we bring the right tools for your budget, team, and customers.
        </p>
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[1.2fr,0.8fr] lg:items-start">
        <div className="grid gap-6 sm:grid-cols-2">
          {services.map((service) => (
            <article key={service.name} className="h-full rounded-3xl border border-white/10 bg-slate-900/50 p-8 text-left shadow-lg shadow-black/20 backdrop-blur transition hover:-translate-y-1 hover:border-brand-500/40 hover:shadow-sky-400/20">
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-xl font-semibold text-white">{service.name}</h3>
                <span className="rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-200">
                  {service.details.length} highlights
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-300">{service.description}</p>
              <ul className="mt-6 space-y-3 text-sm text-slate-200">
                {service.details.map((detail) => (
                  <li key={detail} className="flex items-start gap-3">
                    <span className="mt-1 h-2 w-2 flex-none rounded-full bg-brand-400" />
                    <span>{detail}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="grid gap-4">
          <figure className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/40 shadow-2xl shadow-black/40">
            <img
              src="https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=1200&auto=format&fit=crop"
              alt="Developer writing code for a cloud application"
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </figure>
          <div className="grid gap-4 sm:grid-cols-2">
            <figure className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/40">
              <img
                src="https://images.unsplash.com/photo-1483478550801-ceba5fe50e8e?q=80&w=900&auto=format&fit=crop"
                alt="Cloud infrastructure diagram on a screen"
                className="h-40 w-full object-cover"
                loading="lazy"
              />
            </figure>
            <figure className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/40">
              <img
                src="https://images.unsplash.com/photo-1517430816045-df4b7de11d1d?q=80&w=900&auto=format&fit=crop"
                alt="Team monitoring deployment dashboards"
                className="h-40 w-full object-cover"
                loading="lazy"
              />
            </figure>
          </div>
        </div>
      </div>
    </section>
  )
}
