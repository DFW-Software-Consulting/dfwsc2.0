import { MaskLine, RevealItem } from "./Reveal.jsx";

/** Page-hero eyebrow plus a two-line h1 rising from behind a mask (inside a <RevealGroup>). */
export default function HeroHeading({ eyebrow, lead, accent }) {
  return (
    <>
      <RevealItem as="p" className="studio-eyebrow">
        {eyebrow}
      </RevealItem>
      <h1>
        <MaskLine>{lead}</MaskLine>
        <MaskLine>
          <em>{accent}</em>
        </MaskLine>
      </h1>
    </>
  );
}
