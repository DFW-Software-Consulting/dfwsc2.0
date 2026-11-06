import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import DiegoEspinoImage from "../assets/diego-espino.jpg";
import HectorOropesaImage from "../assets/hector-oropesa.webp";
import JeremyAshleyImage from "../assets/jeremy-ashley.jpg";
import CtaStrip from "../components/CtaStrip.jsx";
import Disclosure from "../components/Disclosure.jsx";
import HeroBackdrop, { loadTerrain } from "../components/HeroBackdrop.jsx";
import HeroHeading from "../components/motion/HeroHeading.jsx";
import { MotionRoot, RevealGroup, RevealItem } from "../components/motion/Reveal.jsx";
import {
  LEAVE,
  PAGE_HERO,
  RISE,
  ScrollFx,
  ScrollRule,
  useSectionProgress,
} from "../components/motion/ScrollFx.jsx";
import SectionHeading from "../components/motion/SectionHeading.jsx";
import { useTilt } from "../components/motion/useTilt.js";
import { teamMembers } from "../content/team.js";
import "../styles/studio.css";
import "./Team.css";

const memberImages = {
  "Jeremy Ashley": JeremyAshleyImage,
  "Diego Espino": DiegoEspinoImage,
  "Hector Oropesa": HectorOropesaImage,
};

const LINKEDIN_PATH =
  "M20.447 20.452h-3.554v-5.569c0-1.328-.024-3.037-1.852-3.037-1.853 0-2.137 1.447-2.137 2.941v5.665H9.35V9h3.414v1.561h.048c.476-.9 1.637-1.85 3.37-1.85 3.602 0 4.268 2.371 4.268 5.455zm-15.34-12.27a2.062 2.062 0 1 1 .002-4.124 2.062 2.062 0 0 1-.002 4.124zm1.779 12.27H3.33V9h3.556z";

/**
 * A member's photo with its name badge. With a LinkedIn profile the whole frame is one
 * link (opens in a new tab); without one it stays a plain container.
 */
export function MemberPhoto({ name, image, linkedin, wipe }) {
  const badge = (
    <span className="studio-member-badge" aria-hidden="true">
      {name}
      {linkedin ? (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          className="studio-member-badge-icon"
        >
          <path d={LINKEDIN_PATH} />
        </svg>
      ) : null}
    </span>
  );
  if (!linkedin) {
    return (
      <RevealItem wipe={wipe} className="studio-member-photo">
        <img src={image} alt={name} loading="lazy" />
        {badge}
      </RevealItem>
    );
  }
  return (
    <RevealItem
      as="a"
      wipe={wipe}
      className="studio-member-photo studio-member-photo-link"
      href={linkedin}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${name} on LinkedIn (opens in a new tab)`}
    >
      <img src={image} alt="" loading="lazy" />
      {badge}
    </RevealItem>
  );
}

/**
 * A member card that rises into place on scroll, tilts toward a fine pointer, wipes its
 * photo open from its own edge, and slides the copy in from that side, line by line.
 * Cards alternate sides (the even ones have the photo on the right).
 */
function TeamMember({ member, index }) {
  const tilt = useTilt();
  const photoRight = index % 2 === 1;
  const x = photoRight ? 28 : -28;
  return (
    <ScrollFx className="studio-member-item" fx={RISE} {...tilt}>
      <RevealGroup as="article" className="studio-member studio-spot" stagger={0.09}>
        <MemberPhoto
          name={member.name}
          image={memberImages[member.name]}
          linkedin={member.linkedin}
          wipe={photoRight ? "right" : "left"}
        />
        <div className="studio-member-copy">
          <RevealItem as="p" x={x} y={0} className="studio-mini-label">
            {member.role}
          </RevealItem>
          <RevealItem as="h3" x={x} y={0}>
            {member.name}
          </RevealItem>
          <RevealItem as="p" x={x} y={0} className="studio-member-intro">
            {member.intro}
          </RevealItem>
          <RevealItem x={x} y={0}>
            <Disclosure
              summary={
                <>
                  Read more<span className="sr-only"> about {member.name}</span>
                </>
              }
              className="studio-member-bio"
            >
              <p>{member.bio}</p>
            </Disclosure>
          </RevealItem>
          <dl className="studio-member-focus">
            <RevealItem as="dt">FOCUS</RevealItem>
            <RevealItem as="dd">{member.focus}</RevealItem>
          </dl>
        </div>
      </RevealGroup>
    </ScrollFx>
  );
}

export default function Team() {
  const heroRef = useRef(null);
  const heroProgress = useSectionProgress(heroRef, LEAVE);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <MotionRoot>
      <div className="studio studio-page">
        <section className="studio-page-hero studio-team-hero" ref={heroRef}>
          <HeroBackdrop progress={heroProgress} load={loadTerrain} />
          <ScrollFx progress={heroProgress} fx={PAGE_HERO} className="studio-team-hero-content">
            <RevealGroup mount className="page-wrap">
              <HeroHeading
                eyebrow="SMALL TEAM. DIRECT CONNECTION."
                lead="Good software."
                accent="Real people."
              />
              <RevealItem as="p">
                We’re the people who turn your business challenges into a plan, a working
                application, and the support to keep improving.
              </RevealItem>
              <RevealItem className="studio-actions">
                <a className="studio-button" href="#people">
                  Meet your team <span aria-hidden="true">↓</span>
                </a>
                <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
                  Tell us about your business <span aria-hidden="true">↗</span>
                </Link>
              </RevealItem>
              <RevealItem className="studio-team-hero-note">
                Dallas–Fort Worth based · Working remotely with businesses across the US
              </RevealItem>
            </RevealGroup>
          </ScrollFx>
        </section>
        <section id="people" className="studio-section page-wrap">
          <SectionHeading
            eyebrow="THE PEOPLE BEHIND THE WORK"
            lead="Meet your"
            accent="development team."
          >
            Business understanding, application development, and the systems behind it—all part of
            the same conversation.
          </SectionHeading>
          <ScrollRule />
          <div className="studio-member-list">
            {teamMembers.map((member, index) => (
              <TeamMember key={member.name} member={member} index={index} />
            ))}
          </div>
        </section>
        <CtaStrip title="Let’s put a team behind your idea." label="Talk about your project" />
      </div>
    </MotionRoot>
  );
}
