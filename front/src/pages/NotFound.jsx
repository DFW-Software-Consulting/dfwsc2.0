import { Link } from "react-router-dom";
import "../styles/studio.css";
import "./NotFound.css";

// A route that draws itself and then breaks off. pathLength="1" lets the CSS draw it without
// measuring; with reduced motion the finished drawing is shown as is.
function LostRoute() {
  return (
    <svg
      className="studio-lost-route"
      viewBox="0 0 240 150"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path className="lost-grid" d="M0 50h240M0 100h240M60 0v150M120 0v150M180 0v150" />
      <path className="lost-line" pathLength="1" d="M24 118C58 118 56 66 92 66S130 104 156 84" />
      <path className="lost-gap" d="M156 84C170 73 178 62 196 50" />
      <circle className="lost-start" cx="24" cy="118" r="7" />
      <path className="lost-x" d="M190 36l16 16m0-16l-16 16" />
    </svg>
  );
}

export default function NotFound() {
  return (
    <div className="studio studio-notfound">
      <div className="page-wrap studio-notfound-grid" role="status" aria-live="polite">
        <div>
          <p className="studio-eyebrow">404</p>
          <h1>
            Page not found. <em>Let’s get you back on the map.</em>
          </h1>
          <p>The page you are looking for does not exist or has been moved.</p>
          <div className="studio-actions">
            <Link className="studio-button" to="/">
              Back to home <span aria-hidden="true">↗</span>
            </Link>
            <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
              Contact us <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
        <LostRoute />
      </div>
    </div>
  );
}
