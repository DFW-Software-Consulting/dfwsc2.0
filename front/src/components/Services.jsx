export default function Services() {
  const services = [
    {
      name: "API & Data",
      bullets: ["REST/GraphQL", "Auth & RBAC", "Postgres/SQLite", "Stripe integrations"],
      img: "https://images.unsplash.com/photo-1556157382-97eda2d62296?q=80&w=1200&auto=format&fit=crop"
    },
    {
      name: "Web Apps",
      bullets: ["Next.js/React", "Vite + Tailwind", "Design systems", "SEO & performance"],
      img: "https://images.unsplash.com/photo-1487014679447-9f8336841d58?q=80&w=1200&auto=format&fit=crop"
    },
    {
      name: "Cloud & DevOps",
      bullets: ["Docker/Compose", "Vercel/Render", "Nginx/Cloudflare", "CI/CD & monitoring"],
      img: "https://images.unsplash.com/photo-1515378791036-0648a3ef77b2?q=80&w=1200&auto=format&fit=crop"
    },
    {
      name: "AI Tooling",
      bullets: ["Local models (Ollama)", "Agentic testing", "Docs generators", "Prompt libraries"],
      img: "https://images.unsplash.com/photo-1518779578993-ec3579fee39f?q=80&w=1200&auto=format&fit=crop"
    }
  ]
  return (
    <section id="services" className="container-px section-y">
      <div className="mx-auto mb-10 max-w-3xl text-center">
        <h2 className="text-3xl font-bold sm:text-4xl">What we do</h2>
        <p className="mt-3 text-slate-300">From idea to prod — we cover the stack and ship iteratively.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {services.map((s)=> (
          <article key={s.name} className="card overflow-hidden">
            <img src={s.img} alt={s.name} className="h-56 w-full object-cover" loading="lazy" />
            <div className="p-6">
              <h3 className="text-xl font-semibold">{s.name}</h3>
              <ul className="mt-3 grid list-disc gap-1 pl-5 text-sm text-slate-300 sm:grid-cols-2">
                {s.bullets.map((b)=> <li key={b}>{b}</li>)}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
