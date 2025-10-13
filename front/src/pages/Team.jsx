import { useEffect } from 'react'
import { Link } from 'react-router-dom'

const teamMembers = [
  {
    name: 'Ava Martinez',
    role: 'Principal Consultant & Solutions Architect',
    bio: 'Leads end-to-end platform delivery with a focus on resilient cloud infrastructure, API design, and measurable outcomes.',
  },
  {
    name: 'Noah Patterson',
    role: 'Staff Software Engineer',
    bio: 'Specializes in full-stack TypeScript development, modernization of legacy systems, and performance-focused web applications.',
  },
  {
    name: 'Maya Chen',
    role: 'Product & Delivery Lead',
    bio: 'Partners with stakeholders to define roadmaps, align project delivery, and keep teams shipping customer-loved experiences.',
  },
]

export default function Team() {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300/80">Meet our team</p>
          <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">Experts building reliable software outcomes</h1>
          <p className="mt-4 max-w-2xl text-base text-slate-400">
            Every engagement is led by seasoned practitioners who have shipped critical systems for finance, logistics, and high-growth
            startups. We stay close to business goals, turning strategy into running software.
          </p>
        </div>
        <Link
          to="/"
          state={{ scrollTo: 'contact' }}
          className="inline-flex items-center justify-center rounded-full border border-brand-500/60 px-5 py-2 text-sm font-semibold text-brand-200 transition hover:border-brand-400 hover:text-brand-100"
        >
          Start a project
        </Link>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {teamMembers.map((member) => (
          <article
            key={member.name}
            className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_40px_80px_-50px_rgba(11,114,133,0.8)] transition hover:-translate-y-1 hover:bg-white/10"
          >
            <div className="absolute inset-x-4 top-4 h-28 rounded-3xl bg-gradient-to-br from-brand-500/20 via-brand-400/10 to-transparent blur-2xl transition duration-500 group-hover:opacity-100" />
            <div className="relative">
              <h2 className="text-xl font-semibold text-white">{member.name}</h2>
              <p className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-brand-200/80">{member.role}</p>
              <p className="mt-4 text-sm leading-relaxed text-slate-300">{member.bio}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
