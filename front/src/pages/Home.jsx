import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Contact from "../components/Contact.jsx";
import HeroBackdrop from "../components/HeroBackdrop.jsx";
import { MotionRoot, Reveal, RevealGroup, RevealItem, Swap } from "../components/motion/Reveal.jsx";
import {
  LEAVE,
  PASS,
  ProcessGrid,
  ScrollFx,
  ScrollGroup,
  ScrollItem,
  useSectionProgress,
} from "../components/motion/ScrollFx.jsx";
import { scrollToSection } from "../utils/scrollToSection.js";
import "../styles/studio.css";
import "./Home.css";
import { usePageTitle } from "../hooks/usePageTitle.js";

const workflows = [
  {
    name: "Client requests",
    eyebrow: "FROM SCATTERED TO CONNECTED",
    title: "A clearer path from request to done.",
    description: "Bring incoming requests, project details, and next steps into one shared view.",
    steps: ["Request received", "Work organized", "Client updated"],
    rows: [
      ["Website update", "In progress"],
      ["New client portal", "Ready for review"],
      ["Payment connection", "Complete"],
    ],
  },
  {
    name: "Invoices",
    eyebrow: "FROM SCATTERED TO CONNECTED",
    title: "Less chasing. More clarity.",
    description:
      "Connect project information and payment status so your team knows what needs attention.",
    steps: ["Work approved", "Invoice prepared", "Payment recorded"],
    rows: [
      ["Website project", "Invoice prepared"],
      ["Monthly support", "Payment received"],
      ["Portal improvements", "Awaiting approval"],
    ],
  },
  {
    name: "Daily operations",
    eyebrow: "FROM SCATTERED TO CONNECTED",
    title: "Give your team a shared picture.",
    description:
      "Replace scattered updates with a workspace built around the way your business operates.",
    steps: ["Information collected", "Tasks assigned", "Progress shared"],
    rows: [
      ["New work request", "Assigned"],
      ["Customer follow-up", "In progress"],
      ["Weekly overview", "Ready to share"],
    ],
  },
  {
    name: "AI workflows",
    eyebrow: "FROM MANUAL TO AUTOMATIC",
    title: "Let AI handle the busywork.",
    description:
      "Sort emails, draft replies, and pull data from documents, with a person approving what matters.",
    steps: ["Email arrives", "AI sorts & drafts", "You approve"],
    rows: [
      ["Inbox triage", "Running"],
      ["Invoice data extraction", "Ready for review"],
      ["Customer reply drafts", "Complete"],
    ],
  },
];
const services = [
  [
    "01",
    "A better front door.",
    "Websites & landing pages",
    "Help customers understand your business and take the next step with a clear, easy-to-use website.",
  ],
  [
    "02",
    "Tools that fit your business.",
    "Custom applications",
    "Client portals, dashboards, and internal tools shaped around how your team actually works.",
  ],
  [
    "03",
    "Less copy. Less paste.",
    "Automation & integrations",
    "Connect the tools you already use and simplify the repetitive steps between them.",
  ],
  [
    "04",
    "A team in your corner.",
    "Ongoing development",
    "Keep improving with development support, hosting, and maintenance beyond the initial launch.",
  ],
];
// Scroll-linked motion (see components/motion/ScrollFx.jsx). Hero progress 0..1 = hero scrolled out.
const IN = [0, 1];
const FADE_OUT = [
  [0.6, 1],
  [1, 0.35],
];
const HERO_TEXT = { y: [IN, [0, 90]], opacity: FADE_OUT };
const HERO_CARD = {
  y: [IN, [0, -80]],
  scale: [IN, [1, 0.93]],
  rotate: [IN, [0, 1.5]], // cancels the card's resting -1.5deg tilt
  opacity: FADE_OUT,
};
const MISSION_HEADLINE = { y: [IN, [28, -28]] }; // PASS: identity when centered
const CONTACT_IN = {
  scale: [IN, [0.94, 1]],
  opacity: [
    [0, 0.7],
    [0, 1],
  ],
};
const CONTACT_OFFSET = ["start end", "start 0.75"];
const processSteps = [
  [
    "01",
    "First, we listen.",
    "Tell us where the work gets stuck. We ask questions, explore your options, and agree on the scope.",
  ],
  [
    "02",
    "Then, you see it.",
    "Early previews and clear check-ins give you a chance to shape the solution as it takes form.",
  ],
  [
    "03",
    "We launch. You grow.",
    "You own the finished code. Keep us as your development team or choose a documented handoff.",
  ],
];
const twoDigits = (n) => String(n).padStart(2, "0");

export default function Home() {
  usePageTitle("Home");
  const [active, setActive] = useState(0);
  const [switched, setSwitched] = useState(false);
  const workflow = workflows[active];
  const heroRef = useRef(null);
  const heroProgress = useSectionProgress(heroRef, LEAVE);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (location.state?.scrollTo) {
      const id = location.state.scrollTo;
      requestAnimationFrame(() => scrollToSection(id));
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location, navigate]);

  return (
    <MotionRoot>
      <div className="studio">
        <section id="top" className="studio-hero" ref={heroRef}>
          <HeroBackdrop progress={heroProgress} />
          <div className="page-wrap studio-hero-grid">
            <ScrollFx progress={heroProgress} fx={HERO_TEXT}>
              <RevealGroup mount stagger={0.09}>
                <RevealItem as="p" className="studio-eyebrow">
                  <span className="studio-status" /> SMALL BUSINESS. BIG POSSIBILITIES.
                </RevealItem>
                <h1>
                  <RevealItem as="span" className="studio-line">
                    Your business.
                  </RevealItem>
                  <RevealItem as="span" className="studio-line">
                    Our expertise.
                  </RevealItem>
                  <RevealItem as="span" className="studio-line">
                    <em>One dev team.</em>
                  </RevealItem>
                </h1>
                <RevealItem as="p" className="studio-intro">
                  Your development team for websites, software, and simpler workflows.
                </RevealItem>
                <RevealItem as="p" className="studio-hero-copy">
                  We help small businesses improve their online presence, connect their tools, and
                  reduce repetitive work. One project or an ongoing partnership—we start by
                  understanding you.
                </RevealItem>
                <RevealItem className="studio-actions">
                  <a className="studio-button" href="#contact">
                    Talk about your project <span aria-hidden="true">↗</span>
                  </a>
                  <a className="studio-text-link" href="#services">
                    Explore our services <span aria-hidden="true">↓</span>
                  </a>
                </RevealItem>
                <RevealItem className="studio-hero-note">
                  <span>Based in Dallas–Fort Worth</span>
                  <span>Working with businesses everywhere</span>
                </RevealItem>
              </RevealGroup>
            </ScrollFx>
            <ScrollFx progress={heroProgress} fx={HERO_CARD}>
              <Reveal mount delay={0.25} y={20} className="studio-preview">
                <div className="studio-preview-label">
                  <span className="studio-status" /> THE POSSIBILITIES, IN PRACTICE{" "}
                  <span>
                    {twoDigits(active + 1)} / {twoDigits(workflows.length)}
                  </span>
                </div>
                <div className="studio-window">
                  <div className="studio-window-bar">
                    <span className="studio-dots" aria-hidden="true">
                      ● ● ●
                    </span>
                    <span>Your business workspace</span>
                    <span aria-hidden="true">↗</span>
                  </div>
                  <div className="studio-workspace">
                    <div className="studio-workspace-header">
                      <div className="studio-monogram">W</div>
                      <div>
                        <strong>Good work starts here.</strong>
                        <small>A little more connected. A lot more clear.</small>
                      </div>
                    </div>
                    <fieldset className="studio-workflow-tabs" aria-label="Workflow examples">
                      {workflows.map((item, index) => (
                        <button
                          type="button"
                          key={item.name}
                          aria-pressed={active === index}
                          onClick={() => {
                            setSwitched(true);
                            setActive(index);
                          }}
                        >
                          {item.name}
                        </button>
                      ))}
                    </fieldset>
                    <div className="studio-workflow-content">
                      <p className="studio-mini-label">{workflow.eyebrow}</p>
                      <h2 aria-live="polite">
                        <Swap as="span" id={active} skipFirst={!switched} className="studio-line">
                          {workflow.title}
                        </Swap>
                      </h2>
                      <Swap id={active} skipFirst={!switched}>
                        <p>{workflow.description}</p>
                        <div className="studio-flow">
                          {workflow.steps.map((step, index) => (
                            <div key={step}>
                              <span>{index + 1}</span>
                              <small>{step}</small>
                            </div>
                          ))}
                        </div>
                        <div className="studio-task-list">
                          {workflow.rows.map(([name, status], index) => (
                            <div key={name}>
                              <span className="studio-task-icon" aria-hidden="true">
                                {index === 2 ? "✓" : "↗"}
                              </span>
                              <span>{name}</span>
                              <small>{status}</small>
                            </div>
                          ))}
                        </div>
                      </Swap>
                    </div>
                    <div className="studio-window-footer">
                      <span className="studio-status" /> Built around your workflow{" "}
                      <span aria-hidden="true">✦</span>
                    </div>
                  </div>
                </div>
                <div className="studio-preview-foot">
                  <p className="studio-preview-caption">
                    Interactive concept · Illustrative data, not a client dashboard
                  </p>
                  <div className="studio-floating-note">
                    <span aria-hidden="true">↳</span> Software should fit your business.
                    <br />
                    <strong>Not the other way around.</strong>
                  </div>
                </div>
              </Reveal>
            </ScrollFx>
          </div>
        </section>
        <div className="studio-promise-strip">
          <div className="page-wrap">
            <span>Small team. Direct access.</span>
            <span>Clear scope. Visible progress.</span>
            <span>Your business. Your code.</span>
          </div>
        </div>
        <section id="services" className="studio-section page-wrap">
          <Reveal className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">WHAT WE CAN BUILD TOGETHER</p>
              <h2>
                Make room for
                <br />
                <em>better work.</em>
              </h2>
            </div>
            <p>
              You know your business. We bring the technical expertise to help it work better—from
              your first website to the tools your team uses every day.
            </p>
          </Reveal>
          <ScrollGroup className="studio-service-grid">
            {services.map(([number, title, category, description], index) => (
              <ScrollItem
                as="article"
                className="studio-service-card"
                key={number}
                index={index}
                count={services.length}
              >
                <div className="studio-card-top">
                  <span>{number}</span>
                  <span aria-hidden="true">↗</span>
                </div>
                <p className="studio-mini-label">{category}</p>
                <h3>{title}</h3>
                <p>{description}</p>
              </ScrollItem>
            ))}
          </ScrollGroup>
        </section>
        <section id="values" className="studio-band">
          <div className="page-wrap">
            <Reveal className="studio-section-heading">
              <div>
                <p className="studio-eyebrow">A PARTNERSHIP, WITH A PLAN</p>
                <h2>
                  No guessing
                  <br />
                  <em>what comes next.</em>
                </h2>
              </div>
              <p>
                Whether you need a new website, a custom application, or ongoing development
                support, we build a solution that fits how you work.
              </p>
            </Reveal>
            <ProcessGrid steps={processSteps} />
          </div>
        </section>
        <section id="mission" className="studio-section page-wrap studio-mission">
          <Reveal>
            <p className="studio-eyebrow">OUR MISSION</p>
            <ScrollFx as="h2" offset={PASS} fx={MISSION_HEADLINE}>
              Technology that works
              <br />
              <em>for your business.</em>
            </ScrollFx>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="studio-mission-statement">
              Our mission is to help small businesses use technology with confidence. We build
              practical software, simplify everyday work, and provide a development team you can
              turn to as your business grows.
            </p>
            <Link className="studio-text-link" to="/team">
              Meet the team behind our mission <span aria-hidden="true">↗</span>
            </Link>
          </Reveal>
        </section>
        <section id="contact" className="studio-contact studio-inverse">
          <ScrollFx className="page-wrap" offset={CONTACT_OFFSET} fx={CONTACT_IN}>
            <div className="studio-contact-grid">
              <div className="studio-contact-copy">
                <p className="studio-eyebrow">LET’S MAKE SOMETHING REAL</p>
                <h2>
                  Your idea.
                  <br />
                  <em>Fully built.</em>
                </h2>
                <p>
                  Web apps, portals, and the systems behind them, planned, built, and launched end
                  to end.
                </p>
                <div className="studio-actions studio-contact-links">
                  <a className="studio-text-link" href="mailto:mail@dfwsc.com">
                    mail@dfwsc.com
                  </a>
                  <span aria-hidden="true">·</span>
                  <a className="studio-text-link" href="tel:+12143260128">
                    (214) 326-0128
                  </a>
                </div>
              </div>
              <Contact />
            </div>
          </ScrollFx>
        </section>
      </div>
    </MotionRoot>
  );
}
