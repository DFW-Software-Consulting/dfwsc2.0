import { Link } from 'react-router-dom'

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
            <nav className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-8 text-sm text-slate-300">
              <Link to="/" className="transition-colors hover:text-white">Home</Link>
              <Link to="/" state={{ scrollTo: 'services' }} className="transition-colors hover:text-white">Services</Link>
              <Link to="/" state={{ scrollTo: 'values' }} className="transition-colors hover:text-white">Values</Link>
              <Link to="/pricing" className="transition-colors hover:text-white">Pricing</Link>
              <Link to="/team" className="transition-colors hover:text-white">Meet our team</Link>
              <Link to="/" state={{ scrollTo: 'contact' }} className="transition-colors hover:text-white">Contact</Link>
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
