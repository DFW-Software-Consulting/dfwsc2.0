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
    <section className="container-px section-y">
      <div className="mx-auto max-w-3xl text-center">
        <span className="badge mb-6">Why teams choose DFWSC</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Strategic partners, not just contractors</h2>
        <p className="mt-4 text-base text-slate-300">
          We blend senior engineering experience with pragmatic planning so you can move fast without creating tech debt.
        </p>
      </div>

      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {promises.map((promise) => (
          <article key={promise.title} className="card p-6 text-left">
            <h3 className="text-lg font-semibold text-white">{promise.title}</h3>
            <p className="mt-3 text-sm text-slate-300">{promise.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
