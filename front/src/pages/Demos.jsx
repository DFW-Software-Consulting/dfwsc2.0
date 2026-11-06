import { useEffect } from "react";
import { Link } from "react-router-dom";
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

function DemoCard({ demo }) {
  return (
    <li className="demo-card">
      <div className="demo-card-media">
        {demo.image ? (
          <img src={demo.image} alt="" loading="lazy" />
        ) : (
          <DemoIcon name={demo.icon} />
        )}
      </div>
      <div className="demo-card-body">
        <p className="studio-mini-label">{demo.industry}</p>
        <h2 className="demo-card-title">{demo.name}</h2>
        <p>{demo.description}</p>
        <a
          className="studio-text-link"
          href={demo.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View live demo: ${demo.name} (opens in a new tab)`}
        >
          View live demo <span aria-hidden="true">↗</span>
        </a>
      </div>
    </li>
  );
}

// Unlisted: not in the nav, footer or sitemap, and served noindex (see PRIVATE_ROUTES in seo/meta.js).
export default function Demos() {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <div className="studio studio-page">
      <section className="studio-page-hero">
        <div className="page-wrap">
          <p className="studio-eyebrow">SAMPLE SITES</p>
          <h1>Sample sites for local businesses.</h1>
          <p>
            Three working examples of what a small business website can look like. Click through,
            poke around, and see how it feels on your phone.
          </p>
        </div>
      </section>
      <section className="studio-section page-wrap" aria-label="Demo sites">
        <ul className="demo-grid">
          {demos.map((demo) => (
            <DemoCard key={demo.url} demo={demo} />
          ))}
        </ul>
      </section>
      <section className="studio-contact studio-inverse">
        <div className="page-wrap">
          <h2>Want something like this for your business?</h2>
          <p>Tell us a bit about what you do and we&apos;ll talk through what would help.</p>
          <div className="studio-actions">
            <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
              Start a project <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
