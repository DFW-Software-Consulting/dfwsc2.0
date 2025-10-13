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
    <section id="values" className="container-px section-y">
      <div className="mx-auto max-w-3xl text-center">
        <span className="badge mb-6">Team values</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Principles that keep partnerships smooth</h2>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {values.map((value) => (
          <article key={value.title} className="card p-8 text-left">
            <h3 className="text-xl font-semibold text-white">{value.title}</h3>
            <p className="mt-4 text-sm text-slate-300">{value.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
