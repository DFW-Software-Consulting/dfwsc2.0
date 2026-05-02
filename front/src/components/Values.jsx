const values = [
  {
    title: "Clarity first",
    description:
      "Straightforward language, visible progress, and decisions explained in plain English.",
  },
  {
    title: "Ownership",
    description: "We ship, document, and either host or hand over cleanly so you stay in control.",
  },
  {
    title: "Sustainability",
    description: "Right-sized tooling, reasonable costs, and a focus on long-term maintainability.",
  },
];

export default function Values() {
  return (
    <section
      id="values"
      className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300"
    >
      <div className="mx-auto max-w-3xl text-center mb-16">
        <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/20 bg-brand-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-800 dark:text-brand-300">
          Team values
        </span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
          Principles that keep partnerships smooth
        </h2>
      </div>

      <div className="grid gap-8 md:grid-cols-3">
        {values.map((value) => (
          <article
            key={value.title}
            className="group relative rounded-2xl border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-10 text-left transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:border-brand-500/30 hover:-translate-y-1 hover:shadow-glow shadow-sm"
          >
            <h3 className="text-2xl font-bold text-[var(--text-main)] group-hover:text-brand-600 dark:group-hover:text-brand-200 transition-colors">
              {value.title}
            </h3>
            <p className="mt-6 text-base text-[var(--text-muted)] leading-relaxed transition-colors">
              {value.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
