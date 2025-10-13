const projects = [
  {
    name: 'CMCDE manufacturing platform',
    result: 'Digitized batch records with role-based approvals and PDF exports.',
    stack: 'Fastify API, Postgres, Azure AD, React admin UI',
    image: 'https://images.unsplash.com/photo-1581092795360-6de89ce8c254?q=80&w=1000&auto=format&fit=crop',
    imageAlt: 'Industrial engineer monitoring a factory dashboard',
  },
  {
    name: 'PropertyLink operations suite',
    result: 'Unified reservations, accounting, and reporting with nightly data syncs.',
    stack: 'Next.js, tRPC, Prisma, Stripe invoicing',
    image: 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?q=80&w=1000&auto=format&fit=crop',
    imageAlt: 'Modern apartment building exterior at sunset',
  },
  {
    name: 'Tali timesheets & billing',
    result: 'Time tracking, invoicing, and ACH payouts with automated QA.',
    stack: 'Node workers, SQLite/PG, Playwright testing, Plaid',
    image: 'https://images.unsplash.com/photo-1556740749-887f6717d7e4?q=80&w=1000&auto=format&fit=crop',
    imageAlt: 'Professional reviewing financial analytics on a tablet',
  },
]

export default function CaseStudies() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">Recent partnerships</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Outcomes across industries</h2>
        <p className="mt-4 text-base text-slate-300">
          We build with your operators, customers, and compliance needs in mind — from manufacturing floors to finance teams.
        </p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-3">
        {projects.map((project) => (
          <article
            key={project.name}
            className="h-full overflow-hidden rounded-3xl border border-white/10 bg-slate-900/50 text-left shadow-lg shadow-black/20 backdrop-blur transition hover:-translate-y-1 hover:border-brand-500/40 hover:shadow-sky-400/20"
          >
            <figure className="h-40 w-full overflow-hidden">
              <img
                src={project.image}
                alt={project.imageAlt}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </figure>
            <div className="p-8">
              <h3 className="text-lg font-semibold text-white">{project.name}</h3>
              <p className="mt-3 text-sm text-slate-300">{project.result}</p>
              <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Stack: {project.stack}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
