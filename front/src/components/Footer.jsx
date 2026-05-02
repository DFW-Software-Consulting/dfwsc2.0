import { Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext.jsx";

const socialLinks = [
  {
    name: "LinkedIn",
    href: "https://www.linkedin.com/company/dfw-software-consulting",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.024-3.037-1.852-3.037-1.853 0-2.137 1.447-2.137 2.941v5.665H9.35V9h3.414v1.561h.048c.476-.9 1.637-1.85 3.37-1.85 3.602 0 4.268 2.371 4.268 5.455zm-15.34-12.27a2.062 2.062 0 1 1 .002-4.124 2.062 2.062 0 0 1-.002 4.124zm1.779 12.27H3.33V9h3.556z" />
      </svg>
    ),
  },
  {
    name: "GitHub",
    href: "https://github.com/DFW-Software-Consulting",
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
    name: "Email",
    href: "mailto:mail@dfwsc.com",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
        <path d="M3.75 5.5A2.75 2.75 0 0 0 1 8.25v7.5A2.75 2.75 0 0 0 3.75 18.5h16.5A2.75 2.75 0 0 0 23 15.75v-7.5A2.75 2.75 0 0 0 20.25 5.5zm.433 1.5h15.634L12 12.568zM2.5 9.014v6.736a1.75 1.75 0 0 0 1.75 1.75h16.5a1.75 1.75 0 0 0 1.75-1.75V9.014l-9.407 6.333a1 1 0 0 1-1.086 0z" />
      </svg>
    ),
  },
];

export default function Footer() {
  const { theme } = useTheme();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-200 dark:border-white/[0.05] bg-[var(--bg-main)] pt-20 pb-10 transition-colors duration-300">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-16 lg:grid-cols-2 lg:gap-24">
          <div className="flex flex-col items-start gap-8">
            <Link
              to="/"
              className="group relative inline-flex items-center gap-3 transition-all duration-300 hover:brightness-110"
            >
              <div className="absolute -inset-2 rounded-xl bg-brand-500/10 blur-xl transition-opacity opacity-0 group-hover:opacity-100" />
              <img
                src="/DFWSC-Logo-HorizWordmarkPNG.png"
                alt="DFW Software Consulting"
                className={`h-8 w-auto relative z-10 transition-all duration-300 ${theme === "dark" ? "invert hue-rotate-180 brightness-125" : ""}`}
              />
            </Link>
            <p className="text-lg text-[var(--text-muted)] leading-relaxed max-w-md transition-colors">
              Dallas-Fort Worth based engineers delivering end-to-end product strategy and resilient
              cloud infrastructure for teams that need shipping momentum.
            </p>
            <div className="flex flex-col gap-3">
              <a
                href="tel:+12143260128"
                className="flex items-center gap-3 text-base font-medium text-[var(--text-muted)] hover:text-brand-600 dark:hover:text-brand-300 transition-colors"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] text-slate-500 dark:text-slate-300">
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
                    <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.61 21 3 13.39 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.24 1.01z" />
                  </svg>
                </span>
                (214) 326-0128
              </a>
              <a
                href="mailto:mail@dfwsc.com"
                className="flex items-center gap-3 text-base font-medium text-[var(--text-muted)] hover:text-brand-600 dark:hover:text-brand-300 transition-colors"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] text-slate-500 dark:text-slate-300">
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
                    <path d="M3.75 5.5A2.75 2.75 0 0 0 1 8.25v7.5A2.75 2.75 0 0 0 3.75 18.5h16.5A2.75 2.75 0 0 0 23 15.75v-7.5A2.75 2.75 0 0 0 20.25 5.5zm.433 1.5h15.634L12 12.568zM2.5 9.014v6.736a1.75 1.75 0 0 0 1.75 1.75h16.5a1.75 1.75 0 0 0 1.75-1.75V9.014l-9.407 6.333a1 1 0 0 1-1.086 0z" />
                  </svg>
                </span>
                mail@dfwsc.com
              </a>
            </div>
            <div className="flex flex-wrap gap-4">
              {socialLinks.map((link) => (
                <a
                  key={link.name}
                  href={link.href}
                  target={link.href.startsWith("http") ? "_blank" : undefined}
                  rel={link.href.startsWith("http") ? "noreferrer" : undefined}
                  className="group flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] text-slate-500 dark:text-slate-300 transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:border-brand-500/30 hover:text-brand-600 dark:hover:text-white hover:-translate-y-1 shadow-sm"
                  aria-label={link.name}
                >
                  {link.icon}
                </a>
              ))}
            </div>
          </div>

          <div className="grid gap-12 sm:grid-cols-2 lg:gap-16">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 transition-colors">
                Navigation
              </h3>
              <nav className="mt-6 flex flex-col gap-4">
                {[
                  { label: "Home", to: "/" },
                  { label: "Services", to: "/", state: { scrollTo: "services" } },
                  { label: "Values", to: "/", state: { scrollTo: "values" } },
                  { label: "Pricing", to: "/pricing" },
                  { label: "Meet our team", to: "/team" },
                  { label: "Contact", to: "/", state: { scrollTo: "contact" } },
                ].map((item) => (
                  <Link
                    key={item.label}
                    to={item.to}
                    state={item.state}
                    className="text-base text-[var(--text-muted)] transition-colors hover:text-brand-600 dark:hover:text-brand-300"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 transition-colors">
                Insights
              </h3>
              <div className="mt-6 space-y-6">
                <a
                  href="https://linkedin.byjc.dev"
                  target="_blank"
                  rel="noreferrer"
                  className="group block"
                >
                  <p className="text-base text-[var(--text-main)] group-hover:text-brand-600 dark:group-hover:text-brand-200 transition-colors">
                    Follow our founder Jeremy Ashley on LinkedIn
                  </p>
                  <span className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-brand-600 dark:text-brand-500 group-hover:text-brand-400 transition-colors">
                    LEARN MORE
                    <svg
                      className="h-3 w-3 transition-transform group-hover:translate-x-1"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 8l4 4m0 0l-4 4m4-4H3"
                      />
                    </svg>
                  </span>
                </a>
                <div className="rounded-2xl border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-4 text-xs text-slate-500 transition-colors">
                  Built with clarity. Own your roadmap.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-20 border-t border-slate-200 dark:border-white/5 pt-10 text-center transition-colors">
          <p className="text-sm text-[var(--text-muted)]">
            © {year} DFW Software Consulting. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
