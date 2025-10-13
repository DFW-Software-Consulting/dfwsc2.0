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
    <section id="process" className="container-px section-y">
      <div className="mx-auto max-w-3xl text-center">
        <span className="badge mb-6">How we work</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">A clear playbook from kickoff to scale</h2>
        <p className="mt-4 text-base text-slate-300">
          Each phase is scoped with milestones, ownership, and a definition of done so you always know what happens next.
        </p>
      </div>

      <ol className="mt-12 grid gap-6 md:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step.title} className="card relative overflow-hidden p-8">
            <span className="absolute -top-3 -left-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500 text-xl font-bold text-white shadow-lg shadow-brand-500/30">
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
