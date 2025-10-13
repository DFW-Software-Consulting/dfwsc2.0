const stacks = [
  { title: 'Frontend', tools: ['React', 'Next.js', 'Vite', 'Tailwind'] },
  { title: 'Backend', tools: ['Fastify', 'Nest', 'FastAPI', '.NET Minimal APIs'] },
  { title: 'Data', tools: ['Postgres', 'Redis', 'Prisma', 'Drizzle'] },
  { title: 'Cloud & Infra', tools: ['Cloudflare Workers', 'AWS', 'Render', 'Vercel', 'Netlify'] },
  { title: 'Media & Delivery', tools: ['Cloudflare Stream', 'Bunny.net', 'Presigned S3/R2 URLs'] },
]

export default function TechStrip() {
  return (
    <section className="border-y border-white/10 bg-slate-900/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">Tech we like</span>
          <h2 className="text-2xl font-semibold text-white sm:text-3xl">Pragmatic stacks matched to your goals</h2>
          <p className="mt-4 text-sm text-slate-300">
            We lean on proven frameworks, not hype. Each project combines maintainable code with infrastructure that&apos;s easy to
            monitor and scale.
          </p>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {stacks.map((stack) => (
            <article key={stack.title} className="h-full rounded-3xl border border-white/10 bg-slate-900/50 p-6 text-left shadow-lg shadow-black/20 backdrop-blur">
              <h3 className="text-lg font-semibold text-white">{stack.title}</h3>
              <ul className="mt-4 space-y-2 text-sm text-slate-300">
                {stack.tools.map((tool) => (
                  <li key={tool} className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-brand-400" />
                    <span>{tool}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
