export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 grid-bg pointer-events-none" />
      <div className="container-px section-y">
        <div className="mx-auto max-w-4xl text-center">
          <span className="badge mb-6">Backend • Frontend • Cloud • AI</span>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
            Build it right. Ship it fast. Scale with confidence.
          </h1>
          <p className="mt-6 text-lg text-slate-300">
            DFW Software Consulting partners with founders and teams to launch modern web apps and APIs
            with rock-solid architecture, clean UX, and production-grade DevOps.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <a href="#contact" className="btn-primary">Get a Quote</a>
            <a href="#work" className="btn-ghost">See Our Work</a>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {[
              {stat: '50+', label: 'features delivered'},
              {stat: '99.9%', label: 'uptime targets'},
              {stat: '2-6 wks', label: 'typical MVP timeline'},
            ].map((i)=> (
              <div key={i.stat} className="card p-6">
                <div className="text-3xl font-extrabold text-white">{i.stat}</div>
                <div className="text-sm text-slate-300">{i.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="relative mx-auto max-w-6xl px-4 pb-6">
        <img
          src="https://images.unsplash.com/photo-1558494949-ef010cbdcc31?q=80&w=1600&auto=format&fit=crop"
          alt="Hero mockup"
          className="w-full rounded-2xl ring-1 ring-white/10"
          loading="lazy"
        />
      </div>
    </section>
  )
}
