export default function Contact() {
  return (
    <section id="contact" className="container-px section-y">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
        <div className="card p-8">
          <h3 className="text-2xl font-semibold">Tell us about your project</h3>
          <p className="mt-2 text-slate-300 text-sm">
            We typically reply within 1 business day. Prefer email? j.c.ashley4363@gmail.com
          </p>
          <form className="mt-6 grid gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-200">Name</label>
              <input className="mt-1 w-full rounded-lg border-white/10 bg-white/5 text-slate-100 placeholder-slate-400" placeholder="Your name" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-200">Email</label>
                <input type="email" className="mt-1 w-full rounded-lg border-white/10 bg-white/5" placeholder="you@company.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-200">Budget</label>
                <select className="mt-1 w-full rounded-lg border-white/10 bg-white/5">
                  <option>Under $2k</option>
                  <option>$2k–$5k</option>
                  <option>$5k–$15k</option>
                  <option>$15k+</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-200">What are you building?</label>
              <textarea rows="4" className="mt-1 w-full rounded-lg border-white/10 bg-white/5" placeholder="Briefly describe your goals" />
            </div>
            <button type="button" className="btn-primary">Send Inquiry</button>
            <p className="text-xs text-slate-400">By sending, you agree to our terms. We never spam.</p>
          </form>
        </div>
        <div className="card overflow-hidden">
          <img
            src="https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?q=80&w=1200&auto=format&fit=crop"
            alt="Team working"
            className="h-64 w-full object-cover"
            loading="lazy"
          />
          <div className="p-8">
            <h4 className="text-lg font-semibold">Why DFWSC?</h4>
            <ul className="mt-3 grid gap-2 text-sm text-slate-300">
              <li>• Milestone-driven delivery with clear docs and READMEs</li>
              <li>• Local DFW network with responsive communication</li>
              <li>• Transparent pricing; Stripe/ACH invoicing</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
