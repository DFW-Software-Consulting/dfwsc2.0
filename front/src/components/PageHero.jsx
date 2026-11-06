import { useEffect } from "react";

/** Plain page hero (eyebrow, h1, one line) for the static pages; scrolls to the top on mount. */
export default function PageHero({ eyebrow, title, children }) {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <section className="studio-page-hero">
      <div className="page-wrap">
        <p className="studio-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
    </section>
  );
}
