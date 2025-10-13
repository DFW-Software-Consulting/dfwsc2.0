const projects = [
  {
    name: 'CMCDE manufacturing platform',
    result: 'Digitized batch records with role-based approvals and PDF exports.',
    stack: 'Fastify API, Postgres, Azure AD, React admin UI',
  },
  {
    name: 'PropertyLink operations suite',
    result: 'Unified reservations, accounting, and reporting with nightly data syncs.',
    stack: 'Next.js, tRPC, Prisma, Stripe invoicing',
  },
  {
    name: 'Tali timesheets & billing',
    result: 'Time tracking, invoicing, and ACH payouts with automated QA.',
    stack: 'Node workers, SQLite/PG, Playwright testing, Plaid',
  },
]

export default function CaseStudies() {
  return (
    <section className="container-px section-y">
      <div className="mx-auto max-w-3xl text-center">
        <span className="badge mb-6">Recent partnerships</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Outcomes across industries</h2>
        <p className="mt-4 text-base text-slate-300">
          We build with your operators, customers, and compliance needs in mind — from manufacturing floors to finance teams.
        </p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-3">
        {projects.map((project) => (
          <article key={project.name} className="card h-full p-8 text-left transition hover:-translate-y-1 hover:border-brand-500/40">
            <h3 className="text-lg font-semibold text-white">{project.name}</h3>
            <p className="mt-3 text-sm text-slate-300">{project.result}</p>
            <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Stack: {project.stack}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
