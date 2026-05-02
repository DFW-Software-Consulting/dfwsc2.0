const services = [
  {
    name: "Custom Web Apps",
    description: "Dashboards, portals, and internal tools with UX that keeps ops moving fast.",
    details: [
      "Design systems in React/Next.js",
      "Role-based access, audit trails",
      "Performance budgets & accessibility",
    ],
  },
  {
    name: "E-commerce & Payments",
    description: "Subscriptions, checkout flows, and secure payment integrations that just work.",
    details: [
      "Stripe, LemonSqueezy, ACH",
      "Inventory, tax, and fulfillment workflows",
      "Multi-step onboarding & verifications",
    ],
  },
  {
    name: "APIs & Integrations",
    description: "REST & GraphQL services, webhooks, and data sync built for reliability.",
    details: [
      "Postgres, Redis, Prisma/Drizzle",
      "Third-party integrations & webhooks",
      "Monitoring, logging, and alerting",
    ],
  },
  {
    name: "Video & File Delivery",
    description: "Streaming, secure downloads, and presigned links with analytics included.",
    details: [
      "Cloudflare Stream & R2",
      "Bunny.net, AWS S3",
      "Access control & DRM-friendly setups",
    ],
  },
  {
    name: "AI-assisted Workflows",
    description: "Practical automation for data extraction, QA, and internal enablement.",
    details: [
      "LLM integrations & prompt libraries",
      "Ollama for secure on-prem inference",
      "Agentic scripts for docs & testing",
    ],
  },
  {
    name: "Cloud Infrastructure",
    description: "Deployments, monitoring, and cost-aware scaling across modern platforms.",
    details: [
      "Cloudflare Workers, AWS, Render",
      "IaC, CI/CD, and observability",
      "On-call and incident response playbooks",
    ],
  },
];

export default function Services() {
  return (
    <section
      id="services"
      className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300"
    >
      <div className="mx-auto max-w-3xl text-center mb-16">
        <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/20 bg-brand-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-800 dark:text-brand-300">
          What we do
        </span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
          Full-stack product delivery without the hand-holding
        </h2>
        <p className="mt-6 text-lg text-[var(--text-muted)]">
          From prototypes to production-critical systems, we bring the right tools for your budget,
          team, and customers.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
        {services.map((service) => (
          <article
            key={service.name}
            className="group relative h-full rounded-[2rem] border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-8 text-left transition-all duration-500 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:border-brand-500/30 hover:shadow-glow shadow-sm"
          >
            <div className="absolute -inset-px rounded-[2rem] bg-gradient-to-br from-brand-500/10 via-transparent to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100 pointer-events-none" />

            <div className="relative z-10">
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-2xl font-bold text-[var(--text-main)] group-hover:text-brand-600 dark:group-hover:text-brand-200 transition-colors duration-300">
                  {service.name}
                </h3>
                <span className="rounded-full border border-brand-500/20 bg-brand-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-brand-800 dark:text-brand-400">
                  {service.details.length} points
                </span>
              </div>
              <p className="mt-4 text-base text-[var(--text-muted)] leading-relaxed">
                {service.description}
              </p>
              <ul className="mt-8 grid gap-4 sm:grid-cols-1">
                {service.details.map((detail) => (
                  <li key={detail} className="flex items-start gap-3 group/item">
                    <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-brand-500 group-hover/item:scale-125 transition-transform" />
                    <span className="text-sm text-[var(--text-muted)] group-hover/item:text-[var(--text-main)] transition-colors">
                      {detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
