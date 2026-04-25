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
    <section id="values" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-3xl text-center mb-16">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-300">
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
            className="group relative rounded-2xl border border-white/5 bg-white/[0.02] p-10 text-left transition-all duration-300 hover:bg-white/[0.04] hover:border-brand-500/30 hover:-translate-y-1 hover:shadow-glow"
          >
            <h3 className="text-2xl font-bold text-white group-hover:text-brand-200 transition-colors">
              {value.title}
            </h3>
            <p className="mt-6 text-base text-slate-400 leading-relaxed">
              {value.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
