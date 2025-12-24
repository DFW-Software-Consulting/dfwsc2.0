import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { scrollToSection } from '../utils/scrollToSection.js'

const navItems = [
  { type: 'scroll', id: 'services', label: 'Solutions' },
  { type: 'scroll', id: 'values', label: 'Values' },
  { type: 'link', href: '/pricing', label: 'Pricing' },
  { type: 'route', href: '/team', label: 'Meet our team' },
]

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  // Unified clickable pill style
  const desktopItemClasses =
    'group relative inline-flex items-center justify-center overflow-hidden rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-slate-300 transition duration-200 hover:border-white/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 cursor-pointer'
  const desktopGlow =
    'pointer-events-none absolute inset-0 rounded-full bg-white/0 opacity-0 transition duration-200 group-hover:opacity-100 group-hover:bg-white/10'

  const mobileItemClasses =
    'group relative overflow-hidden rounded-full border border-white/10 px-4 py-2 text-left text-slate-200 transition duration-200 hover:border-white/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 cursor-pointer'
  const mobileGlow =
    'pointer-events-none absolute inset-0 rounded-full bg-white/0 opacity-0 transition duration-200 group-hover:opacity-100 group-hover:bg-white/10'

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  const handleScroll = (id) => {
    if (location.pathname !== '/') {
      navigate('/', { state: { scrollTo: id } })
      return
    }

    scrollToSection(id)
    setMenuOpen(false)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
      <div className="relative mx-auto flex h-20 w-full max-w-6xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <Link to="/" className="group relative inline-flex items-center gap-3 cursor-pointer bg-sky-200 p-1 rounded-md hover:scale-105 transition-transform duration-200">
          <span className="absolute -left-4 hidden h-12 w-12 rounded-2xl bg-brand-500/20 blur-xl transition group-hover:opacity-90 sm:block" />
<img src="/DFWSC-Logo-HorizWordmarkPNG.png" alt="DFW Software Consulting" className="h-9 w-auto" />
        </Link>

        <nav className="hidden items-center gap-6 text-sm font-medium sm:flex">
          {navItems.map((item) => {
            if (item.type === 'scroll') {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleScroll(item.id)}
                  className={desktopItemClasses}
                  title={item.label}
                >
                  <span aria-hidden="true" className={desktopGlow} />
                  <span className="relative z-10">{item.label}</span>
                </button>
              )
            }

            return (
              <Link
                key={item.label}
                to={item.href}
                className={desktopItemClasses}
                title={item.label}
                aria-current={location.pathname === item.href ? 'page' : undefined}
              >
                <span aria-hidden="true" className={desktopGlow} />
                <span className="relative z-10">{item.label}</span>
              </Link>
            )
          })}
        </nav>

        <Link
          to="/"
          state={{ scrollTo: 'contact' }}
          className="hidden cursor-pointer items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 sm:inline-flex"
          title="Start a project"
        >
          Start a project
        </Link>

        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          className="inline-flex items-center justify-center rounded-full border border-white/10 p-2 text-slate-200 transition hover:border-brand-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 sm:hidden cursor-pointer"
          aria-expanded={menuOpen}
          aria-label="Toggle navigation"
          title="Toggle navigation"
        >
          <span className="relative flex h-5 w-6 flex-col justify-between">
            <span
              className={`h-0.5 w-full transform rounded-full bg-current transition duration-200 ${
                menuOpen ? 'translate-y-2 rotate-45' : ''
              }`}
            />
            <span
              className={`h-0.5 w-full rounded-full bg-current transition-opacity duration-200 ${
                menuOpen ? 'opacity-0' : 'opacity-100'
              }`}
            />
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
                    className={mobileItemClasses}
                    title={item.label}
                  >
                    <span aria-hidden="true" className={mobileGlow} />
                    <span className="relative z-10">{item.label}</span>
                  </button>
                )
              }

              return (
                <Link
                  key={item.label}
                  to={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`${mobileItemClasses} text-center`}
                  title={item.label}
                  aria-current={location.pathname === item.href ? 'page' : undefined}
                >
                  <span aria-hidden="true" className={mobileGlow} />
                  <span className="relative z-10">{item.label}</span>
                </Link>
              )
            })}

            <Link
              to="/"
              state={{ scrollTo: 'contact' }}
              onClick={() => setMenuOpen(false)}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400"
              title="Start a project"
            >
              Start a project
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
