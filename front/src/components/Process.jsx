const steps = [
  {
    title: 'Discover',
    description: 'Short call to define goals, constraints, and success metrics before we scope.',
  },
  {
    title: 'Design',
    description: 'Wireframes, data models, and tech plans so everyone agrees on the build before code ships.',
  },
  {
    title: 'Build',
    description: 'Weekly sprints with preview links, async updates, and tight feedback loops.',
  },
  {
    title: 'Launch',
    description: 'Hardening, QA, documentation, and handoff or managed deploys.',
  },
  {
    title: 'Grow',
    description: 'Analytics, testing, and iteration to keep your product sharp.',
  },
]

export default function Process() {
  return (
    <section id="process" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-100/80">How we work</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">A clear playbook from kickoff to scale</h2>
        <p className="mt-4 text-base text-slate-300">
          Each phase is scoped with milestones, ownership, and a definition of done so you always know what happens next.
        </p>
      </div>

      <ol className="mt-12 grid gap-6 md:grid-cols-2">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="relative overflow-hidden rounded-3xl border border-white/10 bg-slate-900/50 p-8 shadow-lg shadow-black/20 backdrop-blur"
          >
            <span className="absolute -top-3 -left-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500 text-xl font-bold text-white shadow-lg shadow-[0_24px_45px_-20px_rgba(11,114,133,0.3)]">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className="text-xl font-semibold text-white">{step.title}</h3>
            <p className="mt-4 text-sm text-slate-300">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
