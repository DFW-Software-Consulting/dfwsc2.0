import { useState } from "react";
import { Link } from "react-router-dom";
import { useSpotlight } from "../components/motion/useTilt.js";
import PageHero from "../components/PageHero.jsx";
import { demos } from "../content/demos.js";
import "../styles/studio.css";
import "./Demos.css";

const ICONS = {
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
    </>
  ),
  utensils: (
    <>
      <path d="M3 2v7a3 3 0 0 0 3 3v10M9 2v7a3 3 0 0 1-3 3M6 2v7" />
      <path d="M17 22V2c-2.5 1.5-4 4.5-4 8 0 2.2 1.8 4 4 4" />
    </>
  ),
  leaf: (
    <>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" />
      <path d="M2 22c0-5 3-9 9-11" />
    </>
  ),
};

function DemoIcon({ name }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name] ?? ICONS.leaf}
    </svg>
  );
}

// Faux address bar text: host plus path, without the scheme or trailing slash.
function displayUrl(url) {
  const { host, pathname } = new URL(url);
  return `${host}${pathname}`.replace(/\/$/, "");
}

const HOVER_PREVIEW = "(hover: hover) and (prefers-reduced-motion: no-preference)";

// The whole card is one link (no nested interactive elements). Its visible text names it (so
// voice control by "View live demo" works) and the preview images are decorative (alt="").
// The tall scroll image is only mounted, on the first pointer-enter or focus, when the hover
// effect can actually play; touch and reduced-motion visitors never download it, and the
// prerendered HTML has none. It is absolutely positioned, so mounting it shifts nothing.
function DemoCard({ demo }) {
  const spotlight = useSpotlight();
  const [armed, setArmed] = useState(false);
  const [ready, setReady] = useState(false);
  const arm = () => {
    if (!armed && window.matchMedia?.(HOVER_PREVIEW).matches) setArmed(true);
  };
  return (
    <li>
      <a
        className="demo-card studio-spot studio-lift"
        href={demo.url}
        target="_blank"
        rel="noopener noreferrer"
        onPointerEnter={arm}
        onFocus={arm}
        {...spotlight}
      >
        <div className="demo-card-frame" aria-hidden="true">
          <div className="demo-card-bar">
            <span className="demo-card-dots" />
            <span className="demo-card-address">{displayUrl(demo.url)}</span>
          </div>
          <div className="demo-card-media">
            {demo.image ? (
              <>
                <img
                  src={demo.image}
                  alt=""
                  width="1200"
                  height="750"
                  loading="eager"
                  decoding="async"
                />
                {armed && demo.scrollImage && (
                  <img
                    className={ready ? "demo-card-scroll is-ready" : "demo-card-scroll"}
                    onLoad={() => setReady(true)}
                    src={demo.scrollImage}
                    alt=""
                    width="900"
                    height="2250"
                    decoding="async"
                  />
                )}
              </>
            ) : (
              <DemoIcon name={demo.icon} />
            )}
          </div>
        </div>
        <div className="demo-card-body">
          <p className="studio-mini-label">{demo.industry}</p>
          <h2 className="demo-card-title">{demo.name}</h2>
          <p>{demo.description}</p>
          <span className="demo-card-cta">
            View live demo <span aria-hidden="true">↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </span>
        </div>
      </a>
    </li>
  );
}

// Unlisted: not in the nav, footer or sitemap, and served noindex (see PRIVATE_ROUTES in seo/meta.js).
export default function Demos() {
  return (
    <div className="studio studio-page">
      <PageHero eyebrow="SAMPLE SITES" title="Sample sites for local businesses.">
        Three working examples of what a small business website can look like.
      </PageHero>
      <section className="studio-section demo-section page-wrap" aria-label="Demo sites">
        <ul className="demo-grid">
          {demos.map((demo) => (
            <DemoCard key={demo.url} demo={demo} />
          ))}
        </ul>
      </section>
      <p className="demo-cta page-wrap">
        <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
          Want something like this? Start a project <span aria-hidden="true">→</span>
        </Link>
      </p>
    </div>
  );
}
