import { Link } from 'react-router-dom'

const stats = [
  { value: '50+ launches', detail: 'Delivered across web, API, and automation projects' },
  { value: '2–6 week MVPs', detail: 'Milestone plans with weekly previews' },
  { value: '99.9% uptime', detail: 'Production monitoring and incident response' },
]

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(circle_at_center,rgba(0,0,0,0.7),transparent_70%)]" />
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.2fr,1fr]">
          <div className="text-center lg:text-left">
            <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">
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
              <Link to="/pricing" className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400">
                View hosting plans
              </Link>
              <a href="#contact" className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 px-5 py-2.5 text-sm font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:text-white">
                Book a discovery call
              </a>
            </div>
            <div className="mt-12 grid grid-cols-1 gap-4 text-left sm:grid-cols-3">
              {stats.map((item) => (
                <div key={item.value} className="rounded-3xl border border-white/10 bg-slate-900/50 p-6 shadow-lg shadow-black/20 backdrop-blur">
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
              className="relative w-full rounded-3xl border border-white/10 shadow-2xl shadow-[0_30px_60px_-45px_rgba(11,114,133,0.12)]"
              loading="lazy"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
