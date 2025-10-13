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
    <section id="services" className="container-px section-y">
      <div className="mx-auto max-w-3xl text-center">
        <span className="badge mb-6">What we do</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Full-stack product delivery without the hand-holding</h2>
        <p className="mt-4 text-base text-slate-300">
          From prototypes to production-critical systems, we bring the right tools for your budget, team, and customers.
        </p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        {services.map((service) => (
          <article key={service.name} className="card h-full p-8 text-left">
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
    </section>
  )
}
