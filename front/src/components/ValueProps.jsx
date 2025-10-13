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

      <div className="mt-12 grid gap-12 lg:grid-cols-[1.1fr,0.9fr] lg:items-center">
        <div className="grid gap-6 sm:grid-cols-2">
          {promises.map((promise) => (
            <article key={promise.title} className="rounded-3xl border border-white/10 bg-slate-900/50 p-6 text-left shadow-lg shadow-black/20 backdrop-blur transition hover:-translate-y-1 hover:scale-105 hover:border-brand-500/40 hover:shadow-sky-400/20 hover:bg-brand-500">
              <h3 className="text-lg font-semibold text-white">{promise.title}</h3>
              <p className="mt-3 text-sm text-slate-300">{promise.description}</p>
            </article>
          ))}
        </div>

        <div className="grid gap-4">
          <figure className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/40 shadow-2xl shadow-black/40">
            <img
              src="https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?q=80&w=1600&auto=format&fit=crop"
              alt="Developers collaborating while reviewing interface designs"
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </figure>
          <div className="grid gap-4 sm:grid-cols-2">
            <figure className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/40">
              <img
                src="https://images.unsplash.com/photo-1580894897200-6ff3c02f4b94?q=80&w=1000&auto=format&fit=crop"
                alt="Code editor window showing a modern web application layout"
                className="h-40 w-full object-cover"
                loading="lazy"
              />
            </figure>
            <figure className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900/40">
              <img
                src="https://images.unsplash.com/photo-1545239351-1141bd82e8a6?q=80&w=1000&auto=format&fit=crop"
                alt="Team leads mapping architecture on a whiteboard"
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