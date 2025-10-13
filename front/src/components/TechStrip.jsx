export default function TechStrip() {
  const items = ["React", "Next.js", "Fastify", "FastAPI", "PostgreSQL", "Stripe", "Docker", "Vercel", "Cloudflare", "Ollama"]
  return (
    <section className="border-y border-white/10 bg-slate-900/40">
      <div className="container-px py-10">
        <div className="flex flex-wrap items-center justify-center gap-3">
          {items.map((t)=> (
            <span key={t} className="badge">{t}</span>
          ))}
        </div>
      </div>
    </section>
  )
}
