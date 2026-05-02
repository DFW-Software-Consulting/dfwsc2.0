import { Link } from "react-router-dom";

const stats = [
  { value: "50+ launches", detail: "Delivered across web, API, and automation projects" },
  { value: "2–6 week MVPs", detail: "Milestone plans with weekly previews" },
  { value: "99.9% uptime", detail: "Production monitoring and incident response" },
];

export default function Hero() {
  return (
    <section
      id="top"
      className="relative overflow-hidden pt-8 pb-20 transition-colors duration-300"
    >
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgba(11,114,133,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(11,114,133,0.05)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(circle_at_center,white,transparent_80%)] opacity-20 dark:opacity-100" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-[500px] bg-brand-500/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 relative">
        <div className="mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-[1.2fr,1fr]">
          <div className="text-center lg:text-left">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-brand-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-brand-800 dark:text-brand-200 backdrop-blur-sm">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
              </span>
              Dallas–Fort Worth • Remote friendly
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl leading-[1.1]">
              <span className="text-gradient">Modern web apps &</span>
              <br />
              <span className="text-gradient-brand">software solutions</span>
            </h1>
            <p className="mt-8 text-xl text-[var(--text-muted)] max-w-2xl mx-auto lg:mx-0 leading-relaxed transition-colors">
              Scalable backends, intuitive frontends, and cloud-powered platforms. We scope clearly,
              ship fast, and leave you with code you own.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-5 lg:justify-start">
              <Link
                to="/pricing"
                className="group relative inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-b from-brand-400 to-brand-600 px-8 py-3.5 text-base font-semibold text-white shadow-glow transition-all duration-300 hover:shadow-glow-strong hover:-translate-y-1 active:translate-y-0"
              >
                View hosting plans
              </Link>
              <a
                href="#contact"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 dark:border-white/10 bg-white/50 dark:bg-white/[0.02] px-8 py-3.5 text-base font-semibold text-slate-900 dark:text-white backdrop-blur-sm transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.05] hover:border-slate-300 dark:hover:border-white/20 hover:-translate-y-1 active:translate-y-0 shadow-sm"
              >
                Book a discovery call
              </a>
            </div>

            <div className="mt-16 grid grid-cols-1 gap-6 text-left sm:grid-cols-3">
              {stats.map((item) => (
                <div
                  key={item.value}
                  className="group rounded-2xl border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-6 transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.05] hover:border-slate-300 dark:hover:border-white/10 shadow-sm"
                >
                  <p className="text-lg font-bold text-[var(--text-main)] group-hover:text-brand-600 dark:group-hover:text-brand-300 transition-colors">
                    {item.value}
                  </p>
                  <p className="mt-2 text-sm text-[var(--text-muted)] leading-snug transition-colors">
                    {item.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative group lg:mt-0 mt-12">
            <div
              className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-brand-500/20 to-transparent blur-2xl opacity-30 dark:opacity-50 group-hover:opacity-50 dark:group-hover:opacity-80 transition-opacity duration-500"
              aria-hidden="true"
            />
            <div className="relative animate-float">
              <img
                src="https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=1600&auto=format&fit=crop"
                alt="Developer configuring cloud infrastructure"
                className="w-full rounded-[2rem] border border-slate-200 dark:border-white/10 shadow-2xl brightness-100 dark:brightness-90 grayscale-[0.1] hover:grayscale-0 hover:brightness-100 transition-all duration-700"
                loading="lazy"
              />
              <div className="absolute inset-0 rounded-[2rem] bg-gradient-to-t from-slate-200/20 dark:from-[#020617]/40 via-transparent to-transparent opacity-60 pointer-events-none" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
