const projects = [
  {
    name: "CMCDE manufacturing platform",
    result: "Digitized batch records with role-based approvals and PDF exports.",
    stack: "Fastify API, Postgres, Azure AD, React admin UI",
  },
  {
    name: "PropertyLink operations suite",
    result: "Unified reservations, accounting, and reporting with nightly data syncs.",
    stack: "Next.js, tRPC, Prisma, Stripe invoicing",
  },
  {
    name: "Tali timesheets & billing",
    result: "Time tracking, invoicing, and ACH payouts with automated QA.",
    stack: "Node workers, SQLite/PG, Playwright testing, Plaid",
  },
];

export default function CaseStudies() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300">
      <div className="mx-auto max-w-3xl text-center mb-16">
        <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/10 bg-brand-500/5 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
          Recent partnerships
        </span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
          Real outcomes for growing teams
        </h2>
        <p className="mt-6 text-lg text-slate-700 dark:text-slate-300 leading-relaxed transition-colors">
          We build with your operators, customers, and compliance needs in mind — from manufacturing
          floors to finance teams.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {projects.map((project) => (
          <article
            key={project.name}
            className="group relative flex flex-col rounded-[2rem] border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] p-8 text-left transition-all duration-500 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:border-brand-500/30 hover:-translate-y-1 hover:shadow-glow shadow-sm"
          >
            <h3 className="text-xl font-bold text-slate-900 dark:text-white group-hover:text-brand-600 dark:group-hover:text-brand-200 transition-colors leading-tight">
              {project.name}
            </h3>
            <p className="mt-4 text-sm text-slate-700 dark:text-slate-300 leading-relaxed flex-grow">
              {project.result}
            </p>
            <div className="mt-8 pt-6 border-t border-slate-200 dark:border-white/5">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400 block mb-2">
                Tech Stack
              </span>
              <p className="text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors">
                {project.stack}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
