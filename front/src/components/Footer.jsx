import { Link } from 'react-router-dom'

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-white/10 bg-slate-950/80">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 text-sm sm:px-6 lg:px-8">
        <div className="flex flex-col gap-12 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xl space-y-6">
            <Link to="/" className="inline-flex items-center gap-3">
              <img src="/dfwsc-logo.svg" alt="DFW Software Consulting" className="h-9 w-auto" />
              <span className="text-base font-semibold tracking-wide text-white">DFW Software Consulting</span>
            </Link>
            <p className="text-base text-slate-400">
              Dallas-Fort Worth based engineers delivering end-to-end product strategy, resilient cloud infrastructure, and
              measurable outcomes for teams that need shipping momentum.
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

          <nav className="flex flex-wrap gap-x-10 gap-y-4 text-sm text-slate-300 md:flex-nowrap md:text-right">
            <Link to="/" className="transition-colors hover:text-white">
              Home
            </Link>
            <Link to="/" state={{ scrollTo: 'services' }} className="transition-colors hover:text-white">
              Services
            </Link>
            <Link to="/" state={{ scrollTo: 'values' }} className="transition-colors hover:text-white">
              Values
            </Link>
            <Link to="/pricing" className="transition-colors hover:text-white">
              Pricing
            </Link>
            <Link to="/team" className="transition-colors hover:text-white">
              Meet our team
            </Link>
            <Link to="/" state={{ scrollTo: 'contact' }} className="transition-colors hover:text-white">
              Contact
            </Link>
          </nav>
        </div>

        <div className="mt-12 border-t border-white/10 pt-6">
          <p className="text-center text-xs text-slate-500">© {year} DFW Software Consulting. All rights reserved.</p>
        </div>
      </div>
    </footer>
  )
}
