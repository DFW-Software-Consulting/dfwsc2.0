export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/70 backdrop-blur">
      <div className="container-px flex h-16 items-center justify-between">
        <a href="#" className="flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 font-extrabold">DFW</span>
          <span className="text-sm font-semibold tracking-wide text-slate-200">DFW Software Consulting</span>
        </a>
        <nav className="hidden gap-6 text-sm sm:flex">
          <a href="#services" className="hover:text-white text-slate-300">Services</a>
          <a href="#work" className="hover:text-white text-slate-300">Work</a>
          <a href="#contact" className="hover:text-white text-slate-300">Contact</a>
        </nav>
        <a href="#contact" className="btn-primary text-sm">Start a Project</a>
      </div>
    </header>
  )
}
