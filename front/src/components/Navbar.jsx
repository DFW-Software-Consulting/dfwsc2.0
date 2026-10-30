import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext.jsx";
import { scrollToSection } from "../utils/scrollToSection.js";

const navItems = [
  { type: "scroll", id: "services", label: "Solutions" },
  { type: "scroll", id: "values", label: "Values" },
  { type: "link", href: "/pricing", label: "Pricing" },
  { type: "route", href: "/team", label: "Our team" },
];

function ThemeToggle({ theme, toggleTheme, mobile = false }) {
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`${
        mobile
          ? "flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
          : "relative flex h-10 w-10 items-center justify-center rounded-full border border-line transition-colors hover:bg-surface hover:border-line-strong"
      } cursor-pointer group focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
      aria-label={mobile ? undefined : label}
    >
      <div className="relative h-5 w-5">
        {/* Sun icon */}
        <svg
          className={`absolute inset-0 transform transition-all duration-500 ${
            theme === "dark" ? "scale-0 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100"
          } text-amber-700`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
          focusable="false"
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
          aria-hidden="true"
          focusable="false"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </svg>
      </div>
      {mobile && <span className="text-sm font-medium">{label}</span>}
    </button>
  );
}

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(location.pathname);
  const menuButtonRef = useRef(null);

  // Unified clickable pill style
  const desktopItemClasses =
    "group relative inline-flex items-center justify-center overflow-hidden rounded-full border border-line px-4 py-2 text-sm font-medium text-fg-muted transition-colors duration-200 hover:border-line-strong hover:text-fg hover:bg-surface aria-[current=page]:border-line-strong aria-[current=page]:bg-accent-soft aria-[current=page]:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus cursor-pointer";
  const desktopGlow =
    "pointer-events-none absolute inset-0 rounded-full bg-gradient-to-r from-brand-500/0 via-brand-500/5 to-brand-500/0 opacity-0 transition-opacity duration-500 group-hover:opacity-100";

  const mobileItemClasses =
    "group relative overflow-hidden rounded-xl border border-line px-4 py-3 text-left text-fg-muted transition-colors duration-200 hover:border-line-strong hover:text-fg hover:bg-surface aria-[current=page]:border-line-strong aria-[current=page]:bg-accent-soft aria-[current=page]:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus cursor-pointer";
  const mobileGlow =
    "pointer-events-none absolute inset-0 rounded-xl bg-brand-500/0 opacity-0 transition duration-200 group-hover:opacity-100 group-hover:bg-brand-500/5";

  // Close the mobile menu whenever the route changes (e.g. browser back/forward).
  // Adjusted during render (rather than in an effect) since it only needs to
  // react to location.pathname changing.
  if (location.pathname !== prevPathname) {
    setPrevPathname(location.pathname);
    setMenuOpen(false);
  }

  // Escape closes the open mobile menu and returns focus to its toggle.
  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

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

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-page/90 backdrop-blur-xl transition-colors duration-300">
      <div className="page-wrap relative flex h-20 items-center justify-between gap-6">
        <Link
          to="/"
          onClick={handleLogoClick}
          className="group relative inline-flex items-center gap-3 cursor-pointer transition-all duration-300 hover:brightness-110"
        >
          <div className="absolute -inset-2 rounded-xl bg-brand-500/10 blur-xl transition-opacity opacity-0 group-hover:opacity-100" />
          <img
            src="/DFWSC-Logo-HorizWordmarkPNG.png"
            alt="DFW Software Consulting"
            className={`h-8 w-auto relative z-10 transition-all duration-300 ${theme === "dark" ? "invert hue-rotate-180 brightness-125" : ""}`}
          />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-3 text-sm font-medium lg:flex">
          {navItems.map((item) => {
            if (item.type === "scroll") {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleScroll(item.id)}
                  className={desktopItemClasses}
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
                aria-current={location.pathname === item.href ? "page" : undefined}
              >
                <span aria-hidden="true" className={desktopGlow} />
                <span className="relative z-10">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-4 lg:flex">
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          <Link
            to="/"
            state={{ scrollTo: "contact" }}
            className="cursor-pointer items-center justify-center gap-2 rounded-full bg-brand-500 px-6 py-2.5 text-sm font-semibold text-white shadow-glow transition-all duration-300 hover:bg-brand-600 hover:shadow-glow-strong hover:-translate-y-0.5 active:translate-y-0 active:scale-95 inline-flex focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Start a project
          </Link>
        </div>

        <div className="flex items-center gap-4 lg:hidden">
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-line text-fg-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus cursor-pointer"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label="Menu"
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
        <nav
          id="mobile-menu"
          aria-label="Main"
          className="border-t border-line bg-page/95 lg:hidden transition-colors duration-300"
        >
          <div className="page-wrap flex flex-col gap-3 py-6 text-sm font-medium">
            {navItems.map((item) => {
              if (item.type === "scroll") {
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleScroll(item.id)}
                    className={mobileItemClasses}
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
                  className={mobileItemClasses}
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
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-glow transition duration-200 hover:-translate-y-0.5 hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Start a project
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}
