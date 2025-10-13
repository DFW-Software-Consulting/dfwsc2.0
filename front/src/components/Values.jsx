const values = [
  {
    title: 'Clarity first',
    description: 'Straightforward language, visible progress, and decisions explained in plain English.',
  },
  {
    title: 'Ownership',
    description: 'We ship, document, and either host or hand over cleanly so you stay in control.',
  },
  {
    title: 'Sustainability',
    description: 'Right-sized tooling, reasonable costs, and a focus on long-term maintainability.',
  },
]

export default function Values() {
  return (
    <section id="values" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">Team values</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Principles that keep partnerships smooth</h2>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {values.map((value) => (
          <article key={value.title} className="rounded-3xl border border-white/10 bg-slate-900/50 p-8 text-left shadow-lg shadow-black/20 backdrop-blur">
            <h3 className="text-xl font-semibold text-white">{value.title}</h3>
            <p className="mt-4 text-sm text-slate-300">{value.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
