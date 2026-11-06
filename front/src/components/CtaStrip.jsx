import { Link } from "react-router-dom";
import { Reveal } from "./motion/Reveal.jsx";

/** Compact contact call-to-action that closes Pricing and Team (Home keeps the full band). */
export default function CtaStrip({ title, label }) {
  return (
    <section className="studio-cta-strip studio-inverse">
      <Reveal className="page-wrap studio-cta-strip-inner">
        <p>{title}</p>
        <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
          {label} <span aria-hidden="true">↗</span>
        </Link>
      </Reveal>
    </section>
  );
}
