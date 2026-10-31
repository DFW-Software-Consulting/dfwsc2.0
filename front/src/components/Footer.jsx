import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { scrollToTop } from "../utils/scrollToSection.js";
import Logo from "./Logo.jsx";

const exploreLinks = [
  { label: "Solutions", to: "/", state: { scrollTo: "services" } },
  { label: "Values", to: "/", state: { scrollTo: "values" } },
  { label: "Pricing", to: "/pricing" },
  { label: "Our team", to: "/team" },
  { label: "Privacy", to: "/privacy" },
];

function Icon({ d, evenOdd }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0 fill-current">
      <path d={d} fillRule={evenOdd ? "evenodd" : undefined} />
    </svg>
  );
}

const contactLinks = [
  {
    label: "(214) 326-0128",
    href: "tel:+12143260128",
    icon: (
      <Icon d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.61 21 3 13.39 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.24 1.01z" />
    ),
  },
  {
    label: "mail@dfwsc.com",
    href: "mailto:mail@dfwsc.com",
    icon: (
      <Icon d="M3.75 5.5A2.75 2.75 0 0 0 1 8.25v7.5A2.75 2.75 0 0 0 3.75 18.5h16.5A2.75 2.75 0 0 0 23 15.75v-7.5A2.75 2.75 0 0 0 20.25 5.5zm.433 1.5h15.634L12 12.568zM2.5 9.014v6.736a1.75 1.75 0 0 0 1.75 1.75h16.5a1.75 1.75 0 0 0 1.75-1.75V9.014l-9.407 6.333a1 1 0 0 1-1.086 0z" />
    ),
  },
  {
    label: "GitHub",
    href: "https://github.com/DFW-Software-Consulting",
    external: true,
    icon: (
      <Icon
        d="M12 2C6.477 2 2 6.484 2 12.012c0 4.422 2.865 8.166 6.839 9.49.5.091.682-.217.682-.482 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.156-1.11-1.465-1.11-1.465-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.833.091-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.269 2.75 1.026A9.544 9.544 0 0 1 12 7.5a9.53 9.53 0 0 1 2.504.337c1.909-1.295 2.748-1.026 2.748-1.026.546 1.378.203 2.397.1 2.65.64.7 1.027 1.595 1.027 2.688 0 3.848-2.339 4.695-4.566 4.944.359.31.678.92.678 1.856 0 1.338-.012 2.418-.012 2.747 0 .268.18.58.688.48A10.02 10.02 0 0 0 22 12.012C22 6.484 17.523 2 12 2"
        evenOdd
      />
    ),
  },
];

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
});

// Re-renders once per minute, on the minute, and stops on unmount.
function useDallasTime() {
  const [time, setTime] = useState(() => timeFormat.format(new Date()));

  useEffect(() => {
    let timer;
    const tick = () => {
      setTime(timeFormat.format(new Date()));
      timer = setTimeout(tick, 60000 - (Date.now() % 60000));
    };
    timer = setTimeout(tick, 60000 - (Date.now() % 60000));
    return () => clearTimeout(timer);
  }, []);

  return time;
}

export default function Footer() {
  const year = new Date().getFullYear();
  const time = useDallasTime();

  return (
    <footer className="site-footer">
      <div className="page-wrap">
        <div className="site-footer-top">
          <div className="flex flex-col items-start gap-6">
            <Link to="/" aria-label="DFW Software Consulting home" className="site-footer-brand">
              <Logo className="origin-left scale-110 sm:scale-125" />
            </Link>
            <p className="max-w-md text-base leading-relaxed text-fg-muted">
              Websites, custom software, and simpler workflows for small businesses. Based in
              Dallas–Fort Worth, working with businesses everywhere.
            </p>
          </div>

          <nav aria-label="Footer" className="site-footer-nav">
            <div>
              <h2 className="site-footer-heading">Explore</h2>
              <ul className="site-footer-list">
                {exploreLinks.map((item) => (
                  <li key={item.label}>
                    <Link to={item.to} state={item.state} className="site-footer-link">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="site-footer-heading">Contact</h2>
              <ul className="site-footer-list">
                {contactLinks.map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      target={item.external ? "_blank" : undefined}
                      rel={item.external ? "noreferrer" : undefined}
                      className="site-footer-link inline-flex items-center gap-2"
                    >
                      {item.icon}
                      {item.label}
                      {item.external && <span className="sr-only"> (opens in a new tab)</span>}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </div>

        <div className="site-footer-bar">
          <p>© {year} DFW Software Consulting</p>
          <p className="site-footer-time">Dallas, TX · {time}</p>
          <button
            type="button"
            onClick={scrollToTop}
            className="site-footer-link site-footer-top-btn"
          >
            Back to top <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>

      <div className="site-footer-mark" aria-hidden="true">
        <span>DFW</span>
      </div>
    </footer>
  );
}
