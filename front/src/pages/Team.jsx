import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import Banner from '../components/Banner.jsx'
import JcImage from '../assets/jc.jpg'
import DiegoImage from '../assets/diego.jpg'
import SpencerImage from '../assets/spencer.jpg'

const teamMembers = [
  {
    name: 'Jeremy Ashley',
    role: 'Founder & CTO',
    bio: 'Drives technical strategy and architecture across the organization. Oversees full-stack product delivery, DevOps automation, and scalable cloud infrastructure design.',
    image: JcImage,
  },
  {
    name: 'Diego Espino',
    role: 'Full Stack & DevOps Engineer',
    bio: 'Bridges front-end experience with backend reliability. Focused on TypeScript & Python ecosystems, CI/CD pipelines, and performance-driven web applications that scale.',
    image: DiegoImage,
  },
  {
    name: 'Spencer Lillian',
    role: 'Full Stack Engineer',
    bio: 'Collaborates with clients to translate business needs into robust solutions. Supports backend systems, cloud deployments, and continuous delivery workflows.',
    image: SpencerImage,
  },
]

export default function Team() {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-12 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300/80">Meet our team</p>
          <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">
            Experts building reliable software outcomes
          </h1>
          <p className="mt-4 max-w-2xl text-base text-slate-400">
            Every engagement is led by seasoned practitioners who have shipped critical systems for finance, logistics,
            and high-growth startups. We stay close to business goals, turning strategy into running software.
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

      {/* Team Members */}
      <div className="space-y-16">
        {teamMembers.map((member, idx) => (
          <div
            key={member.name}
            className={`flex flex-col items-center gap-8 rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_40px_80px_-50px_rgba(11,114,133,0.8)] transition hover:bg-white/10 md:flex-row ${
              idx % 2 === 1 ? 'md:flex-row-reverse' : ''
            }`}
          >
            {/* Image */}
            <div className="w-full md:w-1/3 flex-shrink-0">
              <img
                src={member.image}
                alt={member.name}
                className="mx-auto h-56 w-56 rounded-full border border-white/10 object-cover shadow-lg md:h-64 md:w-64"
              />
            </div>

            {/* Info */}
            <div className="w-full md:w-2/3 text-center md:text-left">
              <h2 className="text-2xl font-semibold text-white">{member.name}</h2>
              <p className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-brand-200/80">
                {member.role}
              </p>
              <p className="mt-4 text-base leading-relaxed text-slate-300">{member.bio}</p>
            </div>
          </div>
        ))}
      </div>

      <Banner
        className="mt-20"
        message="🤝 Embedded software engineers and web developers partner with you from whiteboard to launch."
      />
    </section>
  )
}