import { Link, useLocation, useNavigate } from 'react-router-dom'

const sections = [
  { id: 'services', label: 'Solutions' },
  { id: 'process', label: 'Process' },
  { id: 'values', label: 'Values' },
]

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()

  const handleScroll = (id) => {
    if (location.pathname !== '/') {
      navigate('/', { state: { scrollTo: id } })
      return
    }

    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/70 backdrop-blur">
      <div className="container-px flex h-16 items-center justify-between gap-6">
        <Link to="/" className="flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 font-extrabold text-slate-950">
            DFW
          </span>
          <span className="text-sm font-semibold tracking-wide text-slate-200">DFW Software Consulting</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm sm:flex">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => handleScroll(section.id)}
              className="text-slate-300 transition hover:text-white"
            >
              {section.label}
            </button>
          ))}
          <Link to="/pricing" className="text-slate-300 transition hover:text-white">
            Pricing
          </Link>
        </nav>
        <Link to="/" state={{ scrollTo: 'contact' }} className="btn-primary hidden text-sm sm:inline-flex">
          Start a project
        </Link>
      </div>
    </header>
  )
}
