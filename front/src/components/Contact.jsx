const contactMethods = [
  { label: 'Email', value: 'dfwsoftwareconsulting@gmail.com', href: 'mailto:dfwsoftwareconsulting@gmail.com' },
  { label: 'Website', value: 'dfwsc.netlify.app', href: 'https://dfwsc.netlify.app/' },
  { label: 'LinkedIn', value: 'DFW Software Consulting', href: 'https://www.linkedin.com/company/dfw-software-consulting' },
]

export default function Contact() {
  return (
    <section id="contact" className="container-px section-y">
      <div className="mx-auto max-w-5xl">
        <div className="mx-auto max-w-3xl text-center">
          <span className="badge mb-6">Start a project</span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Tell us your goal, timeline, and must-haves</h2>
          <p className="mt-4 text-base text-slate-300">
            We&apos;ll respond within one business day with next steps and a lightweight plan you can approve quickly.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
          <div className="card p-8">
            <form className="grid gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-slate-200">Name</label>
                  <input
                    className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    placeholder="Your name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-200">Email</label>
                  <input
                    type="email"
                    className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    placeholder="you@company.com"
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-slate-200">Company or project name</label>
                  <input
                    className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    placeholder="Acme Inc."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-200">Estimated budget</label>
                  <select className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40">
                    <option>Under $5k</option>
                    <option>$5k–$15k</option>
                    <option>$15k–$40k</option>
                    <option>$40k+</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-200">What are you building?</label>
                <textarea
                  rows="4"
                  className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  placeholder="Share the problem, timeline, and any integrations you need"
                />
              </div>
              <button type="button" className="btn-primary w-fit">Send project brief</button>
              <p className="text-xs text-slate-400">We&apos;ll follow up with a discovery call invite and a written proposal.</p>
            </form>
          </div>
          <div className="card flex flex-col justify-between gap-8 p-8">
            <div>
              <h3 className="text-xl font-semibold text-white">Prefer a quick chat?</h3>
              <p className="mt-3 text-sm text-slate-300">
                Share a Loom, forward requirements, or drop a quick note. We&apos;ll respond with next steps and a suggested plan.
              </p>
            </div>
            <ul className="space-y-4 text-sm text-slate-200">
              {contactMethods.map((method) => (
                <li key={method.label} className="flex flex-col">
                  <span className="text-xs uppercase tracking-wide text-slate-400">{method.label}</span>
                  <a href={method.href} className="mt-1 font-medium text-white hover:text-brand-200">
                    {method.value}
                  </a>
                </li>
              ))}
            </ul>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-slate-300">
              Hosting retainers include uptime monitoring, SSL, and maintenance. Feature work is billed hourly at $100–$150/hr
              with clear estimates before kickoff.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
