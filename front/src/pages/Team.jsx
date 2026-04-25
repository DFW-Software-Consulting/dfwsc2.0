import { useEffect } from "react";
import { Link } from "react-router-dom";
import DiegoImage from "../assets/diego.jpg";
import HectorImage from "../assets/hector.webp";
import JcImage from "../assets/jc.jpg";
import SpencerImage from "../assets/spencer.jpg";
import Banner from "../components/Banner.jsx";

const teamMembers = [
  {
    name: "Jeremy Ashley",
    role: "Founder & CTO",
    bio: "Drives technical strategy and architecture across the organization. Oversees full-stack product delivery, DevOps automation, and scalable cloud infrastructure design.",
    image: JcImage,
  },
  {
    name: "Diego Espino",
    role: "Full Stack & DevOps Engineer",
    bio: "Bridges front-end experience with backend reliability. Focused on TypeScript & Python ecosystems, CI/CD pipelines, and performance-driven web applications that scale.",
    image: DiegoImage,
  },
  {
    name: "Spencer Lillian",
    role: "Full Stack Engineer",
    bio: "Collaborates with clients to translate business needs into robust solutions. Supports backend systems, cloud deployments, and continuous delivery workflows.",
    image: SpencerImage,
  },
  {
    name: "Hector Oropesa",
    role: "Full Stack Developer • DevOps & Network Engineer",
    bio: "Combines full-stack development with deep IT and network engineering experience. Bridges software, systems, and networking by managing cloud environments, hardening systems, and supporting scalable, reliable deployments across DevOps workflows.",
    image: HectorImage,
  },
];

export default function Team() {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      {/* Header */}
      <div className="mb-20 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-300">
            Meet our team
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-white sm:text-6xl text-gradient">
            Experts building reliable software outcomes
          </h1>
          <p className="mt-8 text-xl text-slate-400 leading-relaxed">
            Every engagement is led by seasoned practitioners who have shipped critical systems for
            finance, logistics, and high-growth startups. We stay close to business goals, turning
            strategy into running software.
          </p>
        </div>
        <Link
          to="/"
          state={{ scrollTo: "contact" }}
          className="inline-flex w-fit items-center justify-center gap-2 rounded-full bg-brand-500 px-8 py-3 text-base font-bold text-white shadow-glow transition-all duration-300 hover:shadow-glow-strong hover:-translate-y-1"
        >
          Start a project
        </Link>
      </div>

      {/* Team Members */}
      <div className="space-y-12">
        {teamMembers.map((member, idx) => (
          <article
            key={member.name}
            className={`group relative flex flex-col items-center gap-10 rounded-[2.5rem] border border-white/5 bg-white/[0.02] p-10 transition-all duration-500 hover:bg-white/[0.04] md:flex-row ${
              idx % 2 === 1 ? "md:flex-row-reverse" : ""
            }`}
          >
            <div className="absolute -inset-px rounded-[2.5rem] bg-gradient-to-br from-brand-500/10 via-transparent to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100 pointer-events-none" />
            
            {/* Image */}
            <div className="relative w-full md:w-1/3 flex-shrink-0 flex justify-center">
              <div className="relative">
                <div className="absolute -inset-4 rounded-full bg-brand-500/10 blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                <img
                  src={member.image}
                  alt={member.name}
                  className="relative z-10 h-64 w-64 rounded-2xl border border-white/10 object-cover shadow-2xl transition-all duration-500 grayscale-[0.4] group-hover:grayscale-0 group-hover:scale-[1.02]"
                />
              </div>
            </div>

            {/* Info */}
            <div className="relative z-10 w-full md:w-2/3 text-center md:text-left">
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-brand-400">
                {member.role}
              </span>
              <h2 className="mt-2 text-3xl font-bold text-white group-hover:text-brand-100 transition-colors">
                {member.name}
              </h2>
              <p className="mt-6 text-lg leading-relaxed text-slate-400">{member.bio}</p>
            </div>
          </article>
        ))}
      </div>

      <Banner
        className="mt-24 glass rounded-3xl p-6 border-brand-500/20"
        message="🤝 Embedded software engineers and web developers partner with you from whiteboard to launch."
      />
    </section>
  );
}
