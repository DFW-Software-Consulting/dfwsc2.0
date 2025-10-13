import { Link } from 'react-router-dom'

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-white/10 bg-slate-950">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 text-sm text-slate-300 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-[1.5fr,1fr]">
          <div className="space-y-3">
            <h3 className="text-lg font-semibold text-white">DFW Software Consulting</h3>
            <p className="text-sm text-slate-400">
              Managed custom development &amp; hosting — Dallas-Fort Worth, TX. Modern web apps, APIs, and automation built with
              clarity and ownership.
            </p>
            <p className="text-xs text-slate-500">© {year} DFW Software Consulting. All rights reserved.</p>
          </div>
          <div className="grid gap-4 text-sm sm:justify-self-end">
            <div className="flex flex-wrap gap-4">
              <Link to="/" state={{ scrollTo: 'services' }} className="transition-colors hover:text-white">
                Solutions
              </Link>
              <Link to="/" state={{ scrollTo: 'process' }} className="transition-colors hover:text-white">
                Process
              </Link>
              <Link to="/pricing" className="transition-colors hover:text-white">
                Pricing
              </Link>
              <Link to="/" state={{ scrollTo: 'contact' }} className="transition-colors hover:text-white">
                Contact
              </Link>
            </div>
            <div className="flex flex-col gap-2 text-xs text-slate-400">
              <a href="mailto:dfwsoftwareconsulting@gmail.com" className="transition-colors hover:text-white">
                dfwsoftwareconsulting@gmail.com
              </a>
              <a href="https://dfwsc.netlify.app/" className="transition-colors hover:text-white">
                dfwsc.netlify.app
              </a>
              <a href="https://www.linkedin.com/company/dfw-software-consulting" className="transition-colors hover:text-white">
                LinkedIn
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
