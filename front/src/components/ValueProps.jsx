export default function ValueProps() {
  const items = [
    { title: "Backend architecture", desc: "Fastify/Node, Python/FastAPI, PostgreSQL — secure, scalable, and observable."},
    { title: "Front-end experiences", desc: "React/Next.js with accessible, conversion-first UI built on Tailwind."},
    { title: "Cloud & DevOps", desc: "Vercel/Render/Docker, CI/CD, infra-as-code, monitoring, and cost control."},
    { title: "AI-assisted delivery", desc: "Ollama + GPT workflows for testing, docs, and issue generation to move faster."},
  ]
  return (
    <section className="container-px section-y">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((it)=> (
          <div key={it.title} className="card p-6">
            <h3 className="text-lg font-semibold">{it.title}</h3>
            <p className="mt-2 text-sm text-slate-300">{it.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
