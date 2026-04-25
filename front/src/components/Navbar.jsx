import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext.jsx";
import { scrollToSection } from "../utils/scrollToSection.js";

const navItems = [
  { type: "scroll", id: "services", label: "Solutions" },
  { type: "scroll", id: "values", label: "Values" },
  { type: "link", href: "/pricing", label: "Pricing" },
  { type: "route", href: "/team", label: "Meet our team" },
];

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  // Unified clickable pill style
  const desktopItemClasses =
    "group relative inline-flex items-center justify-center overflow-hidden rounded-full border border-white/5 px-4 py-2 text-sm font-medium text-slate-400 transition-all duration-300 hover:border-white/20 hover:text-white hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 cursor-pointer";
  const desktopGlow =
    "pointer-events-none absolute inset-0 rounded-full bg-gradient-to-r from-brand-500/0 via-brand-500/5 to-brand-500/0 opacity-0 transition-opacity duration-500 group-hover:opacity-100";

  const mobileItemClasses =
    "group relative overflow-hidden rounded-xl border border-white/5 px-4 py-3 text-left text-slate-300 transition-all duration-200 hover:border-white/20 hover:text-white hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 cursor-pointer";
  const mobileGlow =
    "pointer-events-none absolute inset-0 rounded-xl bg-white/0 opacity-0 transition duration-200 group-hover:opacity-100 group-hover:bg-white/5";

  useEffect(() => {
    setMenuOpen(false);
  }, []);

  const handleScroll = (id) => {
    if (location.pathname !== "/") {
      navigate("/", { state: { scrollTo: id } });
      return;
    }

    scrollToSection(id);
    setMenuOpen(false);
  };

  const handleLogoClick = (e) => {
    e.preventDefault();
    handleScroll("top");
  };

  const ThemeToggle = ({ mobile = false }) => (
    <button
      type="button"
      onClick={toggleTheme}
      className={`${
        mobile
          ? "flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 text-slate-300 transition-all hover:bg-white/[0.08]"
          : "relative flex h-10 w-10 items-center justify-center rounded-full border border-white/5 transition-all hover:bg-white/[0.05] hover:border-white/20"
      } cursor-pointer group shadow-sm`}
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <div className="relative h-5 w-5">
        {/* Sun icon */}
        <svg
          className={`absolute inset-0 transform transition-all duration-500 ${
            theme === "dark" ? "scale-0 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100"
          } text-amber-500`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.364 17.636l-.707.707M6.364 6.364l.707.707m11.293 11.293l.707.707M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        {/* Moon icon */}
        <svg
          className={`absolute inset-0 transform transition-all duration-500 ${
            theme === "dark" ? "scale-100 rotate-0 opacity-100" : "scale-0 -rotate-90 opacity-0"
          } text-brand-400`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </svg>
      </div>
      {mobile && <span className="text-sm font-medium">{theme === "dark" ? "Switch to Light" : "Switch to Dark"}</span>}
    </button>
  );

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-[var(--bg-main)]/80 backdrop-blur-xl transition-colors duration-300">
      <div className="relative mx-auto flex h-20 w-full max-w-6xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          to="/"
          onClick={handleLogoClick}
          className="group relative inline-flex items-center gap-3 cursor-pointer transition-all duration-300 hover:brightness-110"
        >
          <div className="absolute -inset-2 rounded-xl bg-brand-500/10 blur-xl transition-opacity opacity-0 group-hover:opacity-100" />
          <img
            src="/DFWSC-Logo-HorizWordmarkPNG.png"
            alt="DFW Software Consulting"
            className={`h-8 w-auto relative z-10 brightness-110 transition-all duration-300 ${theme === 'dark' ? 'grayscale-[0.2] hover:grayscale-0' : 'grayscale-0'}`}
          />
        </Link>

        <nav className="hidden items-center gap-4 text-sm font-medium sm:flex">
          {navItems.map((item) => {
            if (item.type === "scroll") {
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
              );
            }

            return (
              <Link
                key={item.label}
                to={item.href}
                className={desktopItemClasses}
                title={item.label}
                aria-current={location.pathname === item.href ? "page" : undefined}
              >
                <span aria-hidden="true" className={desktopGlow} />
                <span className="relative z-10">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-4 sm:flex">
          <ThemeToggle />
          <Link
            to="/"
            state={{ scrollTo: "contact" }}
            className="cursor-pointer items-center justify-center gap-2 rounded-full bg-gradient-to-b from-brand-400 to-brand-600 px-6 py-2.5 text-sm font-semibold text-white shadow-glow transition-all duration-300 hover:shadow-glow-strong hover:-translate-y-0.5 active:translate-y-0 active:scale-95 inline-flex"
            title="Start a project"
          >
            Start a project
          </Link>
        </div>

        <div className="flex items-center gap-4 sm:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex items-center justify-center rounded-full border border-white/10 p-2 text-slate-400 transition hover:border-brand-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 cursor-pointer"
            aria-expanded={menuOpen}
            aria-label="Toggle navigation"
            title="Toggle navigation"
          >
            <span className="relative flex h-5 w-6 flex-col justify-between">
              <span
                className={`h-0.5 w-full transform rounded-full bg-current transition duration-200 ${
                  menuOpen ? "translate-y-2 rotate-45" : ""
                }`}
              />
              <span
                className={`h-0.5 w-full rounded-full bg-current transition-opacity duration-200 ${
                  menuOpen ? "opacity-0" : "opacity-100"
                }`}
              />
              <span
                className={`h-0.5 w-full transform rounded-full bg-current transition duration-200 ${
                  menuOpen ? "-translate-y-2 -rotate-45" : ""
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="border-t border-white/10 bg-[var(--bg-main)]/95 sm:hidden transition-colors duration-300">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-sm font-medium">
            {navItems.map((item) => {
              if (item.type === "scroll") {
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
                );
              }

              return (
                <Link
                  key={item.label}
                  to={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`${mobileItemClasses} text-center`}
                  title={item.label}
                  aria-current={location.pathname === item.href ? "page" : undefined}
                >
                  <span aria-hidden="true" className={mobileGlow} />
                  <span className="relative z-10">{item.label}</span>
                </Link>
              );
            })}

            <Link
              to="/"
              state={{ scrollTo: "contact" }}
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
  );
}
