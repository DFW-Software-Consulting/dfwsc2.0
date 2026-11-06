import { MaskLine, RevealGroup, RevealItem } from "./Reveal.jsx";

/**
 * Section heading whose two lines rise from behind a mask, with the eyebrow and optional
 * copy staggering in. Shared by Team and Pricing so every page enters the same way.
 */
export default function SectionHeading({ eyebrow, lead, accent, children }) {
  return (
    <RevealGroup className="studio-section-heading">
      <div>
        <RevealItem as="p" className="studio-eyebrow">
          {eyebrow}
        </RevealItem>
        <h2>
          <MaskLine>{lead}</MaskLine>
          <MaskLine>
            <em>{accent}</em>
          </MaskLine>
        </h2>
      </div>
      {children ? <RevealItem as="p">{children}</RevealItem> : null}
    </RevealGroup>
  );
}
