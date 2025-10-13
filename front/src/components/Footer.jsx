import { Link } from 'react-router-dom'

const socialLinks = [
  {
    name: 'LinkedIn',
    href: 'https://www.linkedin.com/company/dfw-software-consulting',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.024-3.037-1.852-3.037-1.853 0-2.137 1.447-2.137 2.941v5.665H9.35V9h3.414v1.561h.048c.476-.9 1.637-1.85 3.37-1.85 3.602 0 4.268 2.371 4.268 5.455zm-15.34-12.27a2.062 2.062 0 1 1 .002-4.124 2.062 2.062 0 0 1-.002 4.124zm1.779 12.27H3.33V9h3.556z" />
      </svg>
    ),
  },
  {
    name: 'GitHub',
    href: 'https://github.com/DFW-Software-Consulting',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
        <path
          fillRule="evenodd"
          d="M12 2C6.477 2 2 6.484 2 12.012c0 4.422 2.865 8.166 6.839 9.49.5.091.682-.217.682-.482 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.156-1.11-1.465-1.11-1.465-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.833.091-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.269 2.75 1.026A9.544 9.544 0 0 1 12 7.5a9.53 9.53 0 0 1 2.504.337c1.909-1.295 2.748-1.026 2.748-1.026.546 1.378.203 2.397.1 2.65.64.7 1.027 1.595 1.027 2.688 0 3.848-2.339 4.695-4.566 4.944.359.31.678.92.678 1.856 0 1.338-.012 2.418-.012 2.747 0 .268.18.58.688.48A10.02 10.02 0 0 0 22 12.012C22 6.484 17.523 2 12 2"
        />
      </svg>
    ),
  },
  {
    name: 'Email',
    href: 'mailto:dfwsoftwareconsulting@gmail.com',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
        <path d="M3.75 5.5A2.75 2.75 0 0 0 1 8.25v7.5A2.75 2.75 0 0 0 3.75 18.5h16.5A2.75 2.75 0 0 0 23 15.75v-7.5A2.75 2.75 0 0 0 20.25 5.5zm.433 1.5h15.634L12 12.568zM2.5 9.014v6.736a1.75 1.75 0 0 0 1.75 1.75h16.5a1.75 1.75 0 0 0 1.75-1.75V9.014l-9.407 6.333a1 1 0 0 1-1.086 0z" />
      </svg>
    ),
  },
]

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-white/10 bg-slate-950/80">
      <div className="w-full px-4 py-14 sm:px-8 lg:px-16 xl:px-24">
        <div className="mx-auto max-w-screen-2xl">
          {/* Two-column layout */}
          <div className="flex flex-col gap-12 md:flex-row md:justify-between md:items-start">
            {/* Left: Logo + Branding */}
            <div className="flex-1 space-y-6">
              <Link to="/" className="inline-flex items-center gap-3">
                <img src="/dfwsc-logo.svg" alt="DFW Software Consulting" className="h-9 w-auto" />
                <span className="text-base font-semibold tracking-wide text-white">DFW Software Consulting</span>
              </Link>
              <p className="text-base text-slate-400 max-w-xl">
                Dallas-Fort Worth based engineers delivering end-to-end product strategy, resilient cloud infrastructure,
                and measurable outcomes for teams that need shipping momentum.
              </p>
              <div className="flex flex-wrap gap-3 text-xs text-slate-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 uppercase tracking-[0.25em] text-[0.65rem] text-slate-200/80">
                  Built with clarity
                </span>
                <span className="rounded-full border border-white/5 px-3 py-1 uppercase tracking-[0.25em] text-[0.65rem] text-slate-400">
                  Own your roadmap
                </span>
              </div>
            </div>

            {/* Right: Navigation */}
            <nav className="flex-1 space-y-6 text-sm text-slate-300">
              <div className="grid grid-cols-2 gap-y-3 gap-x-8 sm:grid-cols-3">
                <Link to="/" className="transition-colors hover:text-white">Home</Link>
                <Link to="/" state={{ scrollTo: 'services' }} className="transition-colors hover:text-white">Services</Link>
                <Link to="/" state={{ scrollTo: 'values' }} className="transition-colors hover:text-white">Values</Link>
                <Link to="/pricing" className="transition-colors hover:text-white">Pricing</Link>
                <Link to="/team" className="transition-colors hover:text-white">Meet our team</Link>
                <Link to="/" state={{ scrollTo: 'contact' }} className="transition-colors hover:text-white">Contact</Link>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {socialLinks.map((link) => (
                  <a
                    key={link.name}
                    href={link.href}
                    target={link.href.startsWith('http') ? '_blank' : undefined}
                    rel={link.href.startsWith('http') ? 'noreferrer' : undefined}
                    className="group inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-300 transition hover:-translate-y-0.5 hover:border-white/20 hover:text-white"
                    aria-label={link.name}
                  >
                    {link.icon}
                  </a>
                ))}
              </div>
              <a
                href="linkedin.byjc.dev"
                target="_blank"
                rel="noreferrer"
                className="block text-sm font-semibold text-slate-200 transition hover:text-white"
              >
                Follow our founder Jeremy Ashley on LinkedIn
              </a>
            </nav>
          </div>

          {/* Footer Bottom */}
          <div className="mt-12 border-t border-white/10 pt-6">
            <p className="text-center text-xs text-slate-500">
              © {year} DFW Software Consulting. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
