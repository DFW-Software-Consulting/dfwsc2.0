export default function CaseStudies() {
  const projects = [
    {
      name: "CMCDE — Clean Data Entry",
      desc: "Manufacturing batch‑production records with role‑based flows and audit trails.",
      img: "https://images.unsplash.com/photo-1581092795360-fd1ca04f0952?q=80&w=1200&auto=format&fit=crop"
    },
    {
      name: "PropertyLink",
      desc: "Internal reservation & accounting SaaS with reporting and data imports.",
      img: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?q=80&w=1200&auto=format&fit=crop"
    },
    {
      name: "Tali — Timesheets & Invoices",
      desc: "Fastify API + SQLite/PG with automated tests and invoice generation.",
      img: "https://images.unsplash.com/photo-1551836022-4c4c79ecde51?q=80&w=1200&auto=format&fit=crop"
    }
  ]
  return (
    <section id="work" className="container-px section-y">
      <div className="mx-auto mb-10 max-w-3xl text-center">
        <h2 className="text-3xl font-bold sm:text-4xl">Recent work</h2>
        <p className="mt-3 text-slate-300">A sample of hands‑on builds shipped with speed and care.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {projects.map((p)=> (
          <article key={p.name} className="card overflow-hidden hover:shadow-glow transition-shadow">
            <img src={p.img} alt={p.name} className="h-40 w-full object-cover" loading="lazy" />
            <div className="p-6">
              <h3 className="text-lg font-semibold">{p.name}</h3>
              <p className="mt-2 text-sm text-slate-300">{p.desc}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
