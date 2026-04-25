const steps = [
  {
    title: "Discover",
    description: "Short call to define goals, constraints, and success metrics before we scope.",
  },
  {
    title: "Design",
    description:
      "Wireframes, data models, and tech plans so everyone agrees on the build before code ships.",
  },
  {
    title: "Build",
    description: "Weekly sprints with preview links, async updates, and tight feedback loops.",
  },
  {
    title: "Launch",
    description: "Hardening, QA, documentation, and handoff or managed deploys.",
  },
  {
    title: "Grow",
    description: "Analytics, testing, and iteration to keep your product sharp.",
  },
];

export default function Process() {
  return (
    <section id="process" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300">
      <div className="mx-auto max-w-3xl text-center mb-16">
        <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/10 bg-brand-500/5 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
          How we work
        </span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
          A clear playbook from kickoff to scale
        </h2>
        <p className="mt-6 text-lg text-slate-600 dark:text-slate-400">
          Each phase is scoped with milestones, ownership, and a definition of done so you always
          know what happens next.
        </p>
      </div>

      <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
        {steps.map((step, index) => (
          <article
            key={step.title}
            className="group relative flex flex-col rounded-[2rem] border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/[0.02] p-8 transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:border-brand-500/30 shadow-sm"
          >
            <div className="flex items-center justify-between mb-6">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-lg font-black text-white shadow-glow">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="h-px flex-grow ml-4 bg-slate-200 dark:bg-white/5 transition-colors" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 dark:text-white group-hover:text-brand-600 dark:group-hover:text-brand-200 transition-colors">
              {step.title}
            </h3>
            <p className="mt-4 text-base text-slate-600 dark:text-slate-400 leading-relaxed transition-colors">
              {step.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
