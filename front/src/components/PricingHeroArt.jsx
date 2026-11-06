// Decorative pricing hero art: a blueprint grid drifting behind three tier blocks (Basic,
// Pro, Business) that rise in turn, with a dashed outline above the tallest for "room to
// grow". Pure SVG + CSS (see Pricing.css); hidden from assistive tech, shown on wide
// screens only, and static under reduced motion. Absolutely positioned in the hero, so
// it reserves no layout space and cannot shift anything.

const BLOCKS = [
  { name: "basic", x: 70, y: 232, height: 78 },
  { name: "pro", x: 160, y: 182, height: 128 },
  { name: "business", x: 250, y: 112, height: 198 },
];

export default function PricingHeroArt() {
  return (
    <div className="studio-hero-art" aria-hidden="true">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative, the wrapper is aria-hidden */}
      <svg viewBox="0 0 360 340" focusable="false">
        <defs>
          <pattern id="hero-art-grid" width="30" height="30" patternUnits="userSpaceOnUse">
            <path d="M30 0H0V30" className="hero-art-gridline" />
          </pattern>
        </defs>
        <g className="hero-art-drift">
          <rect x="-30" y="-30" width="420" height="400" fill="url(#hero-art-grid)" />
        </g>
        <line x1="30" y1="310" x2="330" y2="310" className="hero-art-base" />
        {BLOCKS.map(({ name, x, y, height }, index) => (
          <g key={name} className="hero-art-block" style={{ "--i": index }}>
            <rect x={x} y={y} width="64" height={height} rx="6" className="hero-art-face" />
            <line x1={x + 14} y1={y + 16} x2={x + 50} y2={y + 16} className="hero-art-mark" />
            <line x1={x + 14} y1={y + 28} x2={x + 36} y2={y + 28} className="hero-art-mark" />
          </g>
        ))}
        <rect x="250" y="40" width="64" height="62" rx="6" className="hero-art-ghost" />
      </svg>
    </div>
  );
}
