import { Link } from 'react-router-dom'

const stats = [
  { value: '50+ launches', detail: 'Delivered across web, API, and automation projects' },
  { value: '2–6 week MVPs', detail: 'Milestone plans with weekly previews' },
  { value: '99.9% uptime', detail: 'Production monitoring and incident response' },
]

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-bg" />
      <div className="container-px section-y">
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.2fr,1fr]">
          <div className="text-center lg:text-left">
            <span className="badge mb-6 inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-brand-400" />
              Dallas–Fort Worth • Remote friendly
            </span>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
              Modern web apps &amp; software solutions for teams of any size
            </h1>
            <p className="mt-6 text-lg text-slate-300">
              Scalable backends, intuitive frontends, and cloud-powered platforms. We scope clearly, ship fast, and leave you
              with code you own.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
              <Link to="/pricing" className="btn-primary">
                View hosting plans
              </Link>
              <a href="#contact" className="btn-ghost">
                Book a discovery call
              </a>
            </div>
            <div className="mt-12 grid grid-cols-1 gap-4 text-left sm:grid-cols-3">
              {stats.map((item) => (
                <div key={item.value} className="card p-6">
                  <p className="text-base font-semibold text-brand-200">{item.value}</p>
                  <p className="mt-2 text-sm text-slate-300">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="relative">
            <div className="absolute -inset-10 hidden rounded-full bg-brand-500/20 blur-3xl lg:block" aria-hidden="true" />
            <img
              src="https://images.unsplash.com/photo-1558494949-ef010cbdcc31?q=80&w=1600&auto=format&fit=crop"
              alt="Screens showing dashboards and analytics"
              className="relative w-full rounded-3xl border border-white/10 shadow-2xl shadow-brand-500/10"
              loading="lazy"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
