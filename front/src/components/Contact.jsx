const contactMethods = [
  { label: "Email", value: "mail@dfwsc.com", href: "mailto:mail@dfwsc.com" },
  { label: "Website", value: "www.dfwsc.com", href: "https://www.dfwsc.com" },
  {
    label: "LinkedIn",
    value: "DFW Software Consulting",
    href: "https://www.linkedin.com/company/dfw-software-consulting",
  },
];

export default function Contact() {
  return (
    <section id="contact" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300">
      <div className="mx-auto max-w-5xl">
        <div className="mx-auto max-w-3xl text-center mb-16">
          <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/10 bg-brand-500/5 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
            Start a project
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
            Tell us your goal, timeline, and must-haves
          </h2>
          <p className="mt-6 text-lg text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
            We&apos;ll respond within one business day with next steps and a lightweight plan you
            can approve quickly.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-1">
          <div className="flex flex-col md:flex-row items-center justify-between gap-12 rounded-[2.5rem] border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] p-10 lg:p-16 transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm">
            <div className="max-w-md text-center md:text-left">
              <h3 className="text-3xl font-bold text-slate-900 dark:text-white transition-colors">Prefer a quick chat?</h3>
              <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
                Share a Loom, forward requirements, or drop a quick note. We&apos;ll respond with
                next steps and a suggested plan.
              </p>
              
              <div className="mt-10 p-6 rounded-2xl border border-brand-500/10 bg-brand-500/5 text-sm text-brand-700 dark:text-brand-200/80 leading-relaxed transition-colors">
                <strong className="text-brand-600 dark:text-brand-200 block mb-1 uppercase text-xs tracking-widest transition-colors">Pricing Note:</strong>
                Hosting retainers include uptime monitoring, SSL, and maintenance. Feature work is
                billed hourly at $100–$150/hr with clear estimates.
              </div>
            </div>

            <div className="w-full max-w-sm space-y-6">
              {contactMethods.map((method) => (
                <a
                  key={method.label}
                  href={method.href}
                  className="group flex flex-col p-6 rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-white/[0.02] transition-all duration-300 hover:bg-slate-50 dark:hover:bg-white/[0.08] hover:border-brand-500/30 shadow-sm"
                >
                  <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors font-bold">
                    {method.label}
                  </span>
                  <span className="mt-2 text-xl font-bold text-slate-900 dark:text-white group-hover:text-brand-500 dark:group-hover:text-brand-100 transition-colors">
                    {method.value}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
