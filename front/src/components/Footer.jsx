export default function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="border-t border-white/10 bg-slate-950">
      <div className="container-px py-8 text-sm text-slate-300">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p>© {year} DFW Software Consulting — All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a href="#services" className="hover:text-white">Services</a>
            <a href="#work" className="hover:text-white">Work</a>
            <a href="#contact" className="hover:text-white">Contact</a>
          </div>
        </div>
      </div>
    </footer>
  )
}
