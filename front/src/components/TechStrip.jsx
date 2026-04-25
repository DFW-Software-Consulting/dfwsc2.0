const stacks = [
  { title: "Frontend", tools: ["React", "Next.js", "Vite", "Tailwind"] },
  { title: "Backend", tools: ["Fastify", "Nest", "FastAPI", ".NET Minimal APIs"] },
  { title: "Data", tools: ["Postgres", "Redis", "Prisma", "Drizzle"] },
  { title: "Cloud & Infra", tools: ["Cloudflare Workers", "AWS", "Render", "Vercel", "Netlify"] },
  { title: "Media & Delivery", tools: ["Cloudflare Stream", "Bunny.net", "Presigned S3/R2 URLs"] },
];

export default function TechStrip() {
  return (
    <section className="border-y border-white/[0.05] bg-white/[0.01] py-20">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center mb-16">
          <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-300">
            Tech we like
          </span>
          <h2 className="text-3xl font-bold text-white sm:text-5xl text-gradient">
            Pragmatic stacks matched to your goals
          </h2>
          <p className="mt-6 text-lg text-slate-400">
            We lean on proven frameworks, not hype. Each project combines maintainable code with
            infrastructure that&apos;s easy to monitor and scale.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {stacks.map((stack) => (
            <article
              key={stack.title}
              className="group flex flex-col rounded-2xl border border-white/5 bg-white/[0.02] p-6 transition-all duration-300 hover:bg-white/[0.04] hover:border-brand-500/20"
            >
              <h3 className="text-sm font-bold uppercase tracking-widest text-brand-400 mb-6">
                {stack.title}
              </h3>
              <ul className="space-y-3">
                {stack.tools.map((tool) => (
                  <li key={tool} className="flex items-center gap-2 group/item">
                    <div className="h-1 w-1 rounded-full bg-slate-600 group-hover/item:bg-brand-500 transition-colors" />
                    <span className="text-sm font-medium text-slate-300 group-hover/item:text-white transition-colors">
                      {tool}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
