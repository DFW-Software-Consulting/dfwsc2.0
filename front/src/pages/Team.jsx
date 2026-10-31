import { useEffect } from "react";
import { Link } from "react-router-dom";
import DiegoEspinoImage from "../assets/diego-espino.jpg";
import HectorOropesaImage from "../assets/hector-oropesa.webp";
import JeremyAshleyImage from "../assets/jeremy-ashley.jpg";
import { MotionRoot, Reveal, RevealGroup, RevealItem } from "../components/motion/Reveal.jsx";
import { LEAVE, PAGE_HERO, ProcessGrid, RISE, ScrollFx } from "../components/motion/ScrollFx.jsx";
import "../styles/studio.css";
import "./Team.css";
import { usePageTitle } from "../hooks/usePageTitle.js";

// Add a member's personal profile as `linkedin` (https://www.linkedin.com/in/...) to link their photo.
const teamMembers = [
  {
    name: "Jeremy Ashley",
    linkedin: "https://www.linkedin.com/in/dev-jc/",
    role: "Founder & CTO",
    intro: "Your partner in figuring out what to build—and why.",
    bio: "Drives technical strategy and architecture across the organization. Oversees full-stack product delivery, DevOps automation, and scalable cloud infrastructure design.",
    focus: "Discovery · Technical direction · Full-stack delivery",
    image: JeremyAshleyImage,
  },
  {
    name: "Diego Espino",
    linkedin: "https://www.linkedin.com/in/developerdiego/",
    role: "Full Stack & DevOps Engineer",
    intro: "Turning the plan into software your team can use.",
    bio: "Bridges front-end experience with backend reliability. Focused on TypeScript & Python ecosystems, CI/CD pipelines, and performance-driven web applications that scale.",
    focus: "Application development · Deployment · Performance",
    image: DiegoEspinoImage,
  },
  {
    name: "Hector Oropesa",
    linkedin: "https://www.linkedin.com/in/hectororopesa/",
    role: "Full Stack Developer • DevOps & Network Engineer",
    intro: "Bringing your software, systems, and infrastructure together.",
    bio: "Combines full-stack development with deep IT and network engineering experience. Bridges software, systems, and networking by managing cloud environments, hardening systems, and supporting scalable, reliable deployments across DevOps workflows.",
    focus: "Application development · Cloud systems · Networking",
    image: HectorOropesaImage,
  },
];

const processSteps = [
  [
    "01",
    "A conversation first.",
    "We learn how your team works, what’s getting in the way, and what a useful outcome looks like.",
  ],
  [
    "02",
    "Progress you can see.",
    "Early previews and regular check-ins let you give feedback while the solution is taking shape.",
  ],
  [
    "03",
    "A plan for what’s next.",
    "We discuss ongoing support and handoff options so you know how the work will be maintained.",
  ],
];

const LINKEDIN_PATH =
  "M20.447 20.452h-3.554v-5.569c0-1.328-.024-3.037-1.852-3.037-1.853 0-2.137 1.447-2.137 2.941v5.665H9.35V9h3.414v1.561h.048c.476-.9 1.637-1.85 3.37-1.85 3.602 0 4.268 2.371 4.268 5.455zm-15.34-12.27a2.062 2.062 0 1 1 .002-4.124 2.062 2.062 0 0 1-.002 4.124zm1.779 12.27H3.33V9h3.556z";

/**
 * A member's photo with its name badge. With a LinkedIn profile the whole frame is one
 * link (opens in a new tab); without one it stays a plain container.
 */
export function MemberPhoto({ name, image, linkedin }) {
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
      <div className="studio-member-photo">
        <img src={image} alt={name} loading="lazy" />
        {badge}
      </div>
    );
  }
  return (
    <a
      className="studio-member-photo studio-member-photo-link"
      href={linkedin}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${name} on LinkedIn (opens in a new tab)`}
    >
      <img src={image} alt="" loading="lazy" />
      {badge}
    </a>
  );
}

export default function Team() {
  usePageTitle("Our Team");
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <MotionRoot>
      <div className="studio studio-page">
        <section className="studio-page-hero studio-team-hero">
          <ScrollFx offset={LEAVE} fx={PAGE_HERO}>
            <RevealGroup mount className="page-wrap">
              <RevealItem as="p" className="studio-eyebrow">
                SMALL TEAM. DIRECT CONNECTION.
              </RevealItem>
              <RevealItem as="h1">
                Good software.
                <br />
                <em>Real people.</em>
              </RevealItem>
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
          <Reveal className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">THE PEOPLE BEHIND THE WORK</p>
              <h2>
                Meet your
                <br />
                <em>development team.</em>
              </h2>
            </div>
            <p>
              Business understanding, application development, and the systems behind it—all part of
              the same conversation.
            </p>
          </Reveal>
          <div className="studio-member-list">
            {teamMembers.map((member) => (
              <ScrollFx as="article" className="studio-member" key={member.name} fx={RISE}>
                <MemberPhoto name={member.name} image={member.image} linkedin={member.linkedin} />
                <div className="studio-member-copy">
                  <p className="studio-mini-label">{member.role}</p>
                  <h3>{member.name}</h3>
                  <p className="studio-member-intro">{member.intro}</p>
                  <p className="studio-member-bio">{member.bio}</p>
                  <dl className="studio-member-focus">
                    <dt>FOCUS</dt>
                    <dd>{member.focus}</dd>
                  </dl>
                </div>
              </ScrollFx>
            ))}
          </div>
        </section>
        <section className="studio-band">
          <div className="page-wrap">
            <Reveal className="studio-section-heading">
              <div>
                <p className="studio-eyebrow">HOW WE WORK WITH YOU</p>
                <h2>
                  A shared goal.
                  <br />
                  <em>A clear way forward.</em>
                </h2>
              </div>
              <p>
                You bring the knowledge of your business. We bring the technical perspective and
                explain the choices along the way.
              </p>
            </Reveal>
            <ProcessGrid steps={processSteps} />
          </div>
        </section>
        <section className="studio-contact studio-inverse">
          <Reveal className="page-wrap">
            <p className="studio-eyebrow">YOUR NEXT PROJECT STARTS WITH A CONVERSATION</p>
            <h2>
              Let’s put a team
              <br />
              <em>behind your idea.</em>
            </h2>
            <p>
              Whether you have a detailed plan or a problem you’re still sorting out, tell us where
              you’d like to go.
            </p>
            <div className="studio-actions">
              <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
                Talk about your project <span aria-hidden="true">↗</span>
              </Link>
              <Link className="studio-text-link" to="/pricing">
                Explore ways to work together <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </Reveal>
        </section>
      </div>
    </MotionRoot>
  );
}
