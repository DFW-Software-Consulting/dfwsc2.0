const promises = [
  {
    title: "Clear scope & visibility",
    description:
      "Milestone briefs, Loom walkthroughs, and changelogs keep stakeholders aligned every sprint.",
  },
  {
    title: "Transparent pricing",
    description: "Hosting tiers and feature work are quoted up front so budgets stay predictable.",
  },
  {
    title: "Code you own",
    description: "Private repos, infrastructure handoff, and documentation you can run without us.",
  },
  {
    title: "Responsive partnership",
    description:
      "Slack, email, or async updates that match your team’s style — we fit into your flow.",
  },
];

export default function ValueProps() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-3xl text-center mb-16">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-300">
          Why teams choose DFWSC
        </span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
          Strategic partners, not just contractors
        </h2>
        <p className="mt-6 text-lg text-slate-400">
          We blend senior engineering experience with pragmatic planning so you can move fast
          without creating tech debt.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {promises.map((promise) => (
          <article
            key={promise.title}
            className="group relative rounded-2xl border border-white/5 bg-white/[0.02] p-8 text-left transition-all duration-300 hover:bg-white/[0.04] hover:border-brand-500/30 hover:-translate-y-1 hover:shadow-glow"
          >
            <h3 className="text-xl font-bold text-white group-hover:text-brand-200 transition-colors">
              {promise.title}
            </h3>
            <p className="mt-4 text-sm text-slate-400 leading-relaxed">
              {promise.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
