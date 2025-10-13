const promises = [
  {
    title: 'Clear scope & visibility',
    description: 'Milestone briefs, Loom walkthroughs, and changelogs keep stakeholders aligned every sprint.',
  },
  {
    title: 'Transparent pricing',
    description: 'Hosting tiers and feature work are quoted up front so budgets stay predictable.',
  },
  {
    title: 'Code you own',
    description: 'Private repos, infrastructure handoff, and documentation you can run without us.',
  },
  {
    title: 'Responsive partnership',
    description: 'Slack, email, or async updates that match your team’s style — we fit into your flow.',
  },
]

export default function ValueProps() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">Why teams choose DFWSC</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Strategic partners, not just contractors</h2>
        <p className="mt-4 text-base text-slate-300">
          We blend senior engineering experience with pragmatic planning so you can move fast without creating tech debt.
        </p>
      </div>

      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {promises.map((promise) => (
          <article key={promise.title} className="rounded-3xl border border-white/10 bg-slate-900/50 p-6 text-left shadow-lg shadow-black/20 backdrop-blur transition hover:-translate-y-1 hover:scale-105 hover:border-brand-500/40 hover:shadow-sky-400/20 hover:bg-brand-500">
            <h3 className="text-lg font-semibold text-white">{promise.title}</h3>
            <p className="mt-3 text-sm text-slate-300">{promise.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}