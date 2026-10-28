import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { scrollToSection } from "../utils/scrollToSection.js";
import "./StudioHome.css";

const workflows = [
  {
    name: "Client requests",
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
export default function Home() {
  const [active, setActive] = useState(0);
  const workflow = workflows[active];
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
    <div className="studio">
      <section id="top" className="studio-hero">
        <div className="studio-wrap studio-hero-grid">
          <div>
            <p className="studio-eyebrow">
              <span className="studio-status" /> SMALL BUSINESS. BIG POSSIBILITIES.
            </p>
            <h1>
              Your business.
              <br />
              Our expertise.
              <br />
              <em>One dev team.</em>
            </h1>
            <p className="studio-intro">
              Your development team for websites, software, and simpler workflows.
            </p>
            <p className="studio-hero-copy">
              We help small businesses improve their online presence, connect their tools, and
              reduce repetitive work. One project or an ongoing partnership—we start by
              understanding you.
            </p>
            <div className="studio-actions">
              <a className="studio-button" href="#contact">
                Talk about your project <span aria-hidden="true">↗</span>
              </a>
              <a className="studio-text-link" href="#services">
                Explore our services <span aria-hidden="true">↓</span>
              </a>
            </div>
            <div className="studio-hero-note">
              <span>Based in Dallas–Fort Worth</span>
              <span>Working with businesses everywhere</span>
            </div>
          </div>
          <div className="studio-preview">
            <div className="studio-preview-label">
              <span className="studio-status" /> THE POSSIBILITIES, IN PRACTICE{" "}
              <span>0{active + 1} / 03</span>
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
                      onClick={() => setActive(index)}
                    >
                      {item.name}
                    </button>
                  ))}
                </fieldset>
                <div className="studio-workflow-content" aria-live="polite">
                  <p className="studio-mini-label">FROM SCATTERED TO CONNECTED</p>
                  <h2>{workflow.title}</h2>
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
                </div>
                <div className="studio-window-footer">
                  <span className="studio-status" /> Built around your workflow{" "}
                  <span aria-hidden="true">✦</span>
                </div>
              </div>
            </div>
            <p className="studio-preview-caption">
              Interactive concept · Illustrative data, not a client dashboard
            </p>
            <div className="studio-floating-note">
              <span aria-hidden="true">↳</span> Software should fit your business.
              <br />
              <strong>Not the other way around.</strong>
            </div>
          </div>
        </div>
      </section>
      <div className="studio-promise-strip">
        <div className="studio-wrap">
          <span>Small team. Direct access.</span>
          <span>Clear scope. Visible progress.</span>
          <span>Your business. Your code.</span>
        </div>
      </div>
      <section id="services" className="studio-section studio-wrap">
        <div className="studio-section-heading">
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
        </div>
        <div className="studio-service-grid">
          {services.map(([number, title, category, description]) => (
            <article className="studio-service-card" key={number}>
              <div className="studio-card-top">
                <span>{number}</span>
                <span aria-hidden="true">↗</span>
              </div>
              <p className="studio-mini-label">{category}</p>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
      <section id="values" className="studio-process">
        <div className="studio-wrap">
          <div className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">A PARTNERSHIP, WITH A PLAN</p>
              <h2>
                No guessing
                <br />
                <em>what comes next.</em>
              </h2>
            </div>
            <p>
              Whether you need a new website, a custom application, or ongoing development support,
              we build a solution that fits how you work.
            </p>
          </div>
          <div className="studio-process-grid">
            {[
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
            ].map(([number, title, copy]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section id="mission" className="studio-section studio-wrap studio-mission">
        <div>
          <p className="studio-eyebrow">OUR MISSION</p>
          <h2>
            Technology that works
            <br />
            <em>for your business.</em>
          </h2>
        </div>
        <div>
          <p className="studio-mission-statement">
            Our mission is to help small businesses use technology with confidence. We build
            practical software, simplify everyday work, and provide a development team you can turn
            to as your business grows.
          </p>
          <Link className="studio-text-link" to="/team">
            Meet the team behind our mission <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
      <section id="contact" className="studio-contact">
        <div className="studio-wrap">
          <p className="studio-eyebrow">LET’S MAKE SOMETHING USEFUL</p>
          <h2>
            What’s slowing
            <br />
            <em>your business down?</em>
          </h2>
          <p>
            A website that needs updating? A process your team keeps working around? Tell us what’s
            happening. We’ll help you figure out the next step.
          </p>
          <div className="studio-actions">
            <a className="studio-button" href="mailto:mail@dfwsc.com">
              Let’s talk about it <span aria-hidden="true">↗</span>
            </a>
            <a className="studio-text-link" href="tel:+12143260128">
              (214) 326-0128
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
