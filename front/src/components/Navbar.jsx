import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

const navItems = [
  { type: 'scroll', id: 'services', label: 'Solutions' },
  { type: 'scroll', id: 'values', label: 'Values' },
  { type: 'link', href: '/pricing', label: 'Pricing' },
  // { type: 'route', href: '/team', label: 'Meet our team' },
]

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  const handleScroll = (id) => {
    if (location.pathname !== '/') {
      navigate('/', { state: { scrollTo: id } })
      return
    }

    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    setMenuOpen(false)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
      <div className="relative mx-auto flex h-20 w-full max-w-6xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <Link to="/" className="group relative inline-flex items-center gap-3">
          <span className="absolute -left-4 hidden h-12 w-12 rounded-2xl bg-brand-500/20 blur-xl transition group-hover:opacity-90 sm:block" />
          <img src="/dfwsc-logo.png" alt="DFW Software Consulting" className="h-9 w-auto rounded-full" />
          <span className="text-base font-semibold tracking-wide text-slate-100">DFW Software Consulting</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm font-medium sm:flex">
          {navItems.map((item) => {
            if (item.type === 'scroll') {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleScroll(item.id)}
                  className="text-slate-300 transition hover:text-white"
                >
                  {item.label}
                </button>
              )
            }

            if (item.type === 'link') {
              return (
                <Link key={item.label} to={item.href} className="text-slate-300 transition hover:text-white">
                  {item.label}
                </Link>
              )
            }

            return (
              <Link
                key={item.label}
                to={item.href}
                className="rounded-full border border-transparent px-4 py-1.5 text-slate-200 transition hover:border-brand-400 hover:text-white"
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
        <Link
          to="/"
          state={{ scrollTo: 'contact' }}
          className="hidden items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 sm:inline-flex"
        >
          Start a project
        </Link>
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          className="inline-flex items-center justify-center rounded-full border border-white/10 p-2 text-slate-200 transition hover:border-brand-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 sm:hidden"
          aria-expanded={menuOpen}
          aria-label="Toggle navigation"
        >
          <span className="relative flex h-5 w-6 flex-col justify-between">
            <span
              className={`h-0.5 w-full transform rounded-full bg-current transition duration-200 ${
                menuOpen ? 'translate-y-2 rotate-45' : ''
              }`}
            />
            <span className={`h-0.5 w-full rounded-full bg-current transition-opacity duration-200 ${menuOpen ? 'opacity-0' : 'opacity-100'}`} />
            <span
              className={`h-0.5 w-full transform rounded-full bg-current transition duration-200 ${
                menuOpen ? '-translate-y-2 -rotate-45' : ''
              }`}
            />
          </span>
        </button>
      </div>
      {menuOpen && (
        <div className="border-t border-white/10 bg-slate-950/95 sm:hidden">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-sm font-medium">
            {navItems.map((item) => {
              if (item.type === 'scroll') {
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleScroll(item.id)}
                    className="rounded-full px-4 py-2 text-left text-slate-200 transition hover:bg-white/10"
                  >
                    {item.label}
                  </button>
                )
              }

              if (item.type === 'link') {
                return (
                  <Link
                    key={item.label}
                    to={item.href}
                    onClick={() => setMenuOpen(false)}
                    className="rounded-full px-4 py-2 text-slate-200 transition hover:bg-white/10"
                  >
                    {item.label}
                  </Link>
                )
              }

              return (
                <Link
                  key={item.label}
                  to={item.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-full border border-white/10 px-4 py-2 text-center text-slate-100 transition hover:border-brand-400 hover:bg-white/5"
                >
                  {item.label}
                </Link>
              )
            })}
            <Link
              to="/"
              state={{ scrollTo: 'contact' }}
              onClick={() => setMenuOpen(false)}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400"
            >
              Start a project
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
