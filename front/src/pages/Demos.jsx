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

// The whole card is one link (no nested interactive elements). Its aria-label replaces the
// content as the accessible name, so the preview images are decorative (alt="").
function DemoCard({ demo, first }) {
  const spotlight = useSpotlight();
  const label = `View ${demo.name} live demo (opens in a new tab)`;
  return (
    <li>
      <a
        className="demo-card studio-spot studio-lift"
        href={demo.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
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
                  loading={first ? "eager" : "lazy"}
                  decoding="async"
                />
                {demo.scrollImage && (
                  <img
                    className="demo-card-scroll"
                    src={demo.scrollImage}
                    alt=""
                    width="900"
                    height="2250"
                    loading="lazy"
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
          {demos.map((demo, i) => (
            <DemoCard key={demo.url} demo={demo} first={i === 0} />
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
