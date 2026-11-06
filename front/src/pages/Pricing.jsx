import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MotionRoot, Reveal, RevealGroup, RevealItem } from "../components/motion/Reveal.jsx";
import {
  LEAVE,
  PAGE_HERO,
  ScrollFx,
  ScrollGroup,
  ScrollItem,
} from "../components/motion/ScrollFx.jsx";
import { faqItems, hostingPlans, retainer } from "../content/pricing.js";
import "../styles/studio.css";
import "./Pricing.css";

export default function Pricing() {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <MotionRoot>
      <div className="studio studio-page">
        <section className="studio-page-hero">
          <ScrollFx offset={LEAVE} fx={PAGE_HERO}>
            <RevealGroup mount className="page-wrap">
              <RevealItem as="p" className="studio-eyebrow">
                A GOOD FIT STARTS WITH A CLEAR PLAN
              </RevealItem>
              <RevealItem as="h1">
                The right support.
                <br />
                <em>Room to grow.</em>
              </RevealItem>
              <RevealItem as="p">
                From a single project to your ongoing development team, choose the kind of
                partnership your business needs.
              </RevealItem>
              <RevealItem className="studio-actions">
                <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
                  Talk through your options <span aria-hidden="true">↗</span>
                </Link>
                <a className="studio-text-link" href="#hosting">
                  See hosting plans <span aria-hidden="true">↓</span>
                </a>
              </RevealItem>
            </RevealGroup>
          </ScrollFx>
        </section>
        <section className="studio-section page-wrap">
          <Reveal className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">TWO WAYS TO BUILD WITH US</p>
              <h2>
                A project today.
                <br />
                <em>A partner tomorrow.</em>
              </h2>
            </div>
            <p>
              Start with a defined piece of work, or make us part of your team. We’ll discuss scope,
              priorities, and costs before work begins.
            </p>
          </Reveal>
          <ScrollGroup className="studio-engagement-grid">
            <ScrollItem as="article" className="studio-engagement-card" index={0} count={2}>
              <p className="studio-mini-label">A DEFINED PROJECT</p>
              <h3>
                Let’s build
                <br />
                something useful.
              </h3>
              <p>A new website, custom application, or improvement to the tools you already use.</p>
              <div className="studio-engagement-price">Quoted for your project</div>
              <ul>
                <li>Discovery to understand the problem</li>
                <li>Agreed scope and delivery plan</li>
                <li>Previews and clear communication</li>
                <li>Documentation and a handoff plan</li>
              </ul>
              <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
                Tell us what you have in mind <span aria-hidden="true">↗</span>
              </Link>
            </ScrollItem>
            <ScrollItem
              as="article"
              className="studio-engagement-card studio-engagement-featured studio-inverse"
              index={1}
              count={2}
            >
              <p className="studio-mini-label">{retainer.name} · AN ONGOING PARTNERSHIP</p>
              <h3>
                Your development team.
                <br />
                <em>Without starting over.</em>
              </h3>
              <p>{retainer.includes}.</p>
              <div className="studio-engagement-price">
                {retainer.price} <small>based on your needs</small>
              </div>
              <p className="studio-engagement-detail">
                For growing products that need a consistent team. We’ll work through priorities,
                available hours, and the right scope together.
              </p>
              <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
                Let’s talk about your team <span aria-hidden="true">↗</span>
              </Link>
            </ScrollItem>
          </ScrollGroup>
        </section>
        <section id="hosting" className="studio-band">
          <div className="page-wrap">
            <Reveal className="studio-section-heading">
              <div>
                <p className="studio-eyebrow">HOSTING & MAINTENANCE</p>
                <h2>
                  A home for
                  <br />
                  <em>what you build.</em>
                </h2>
              </div>
              <p>
                Each monthly price includes hosting and a maintenance retainer for repairs and fixes
                to your existing website or application. New builds and features are quoted
                separately.
              </p>
            </Reveal>
            <p className="studio-allowance-draft">
              Proposed allowances for review. Final storage, data transfer, and processing limits
              will be confirmed in your hosting proposal.
            </p>
            <ScrollGroup className="studio-plan-grid">
              {hostingPlans.map((plan, index) => (
                <ScrollItem
                  as="article"
                  className="studio-plan-card"
                  key={plan.name}
                  index={index}
                  count={hostingPlans.length + 1}
                >
                  <h3>{plan.name}</h3>
                  <p className="studio-plan-price">
                    {plan.price} <span>/ month</span>
                  </p>
                  <p className="studio-mini-label">Hosting + maintenance retainer</p>
                  <p className="studio-plan-fit">{plan.idealFor}</p>
                  <dl className="studio-plan-specs">
                    {plan.specs.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="studio-plan-includes">{plan.includes}</p>
                  <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
                    Discuss this plan <span aria-hidden="true">↗</span>
                  </Link>
                </ScrollItem>
              ))}
              <ScrollItem
                as="article"
                className="studio-plan-help"
                index={hostingPlans.length}
                count={hostingPlans.length + 1}
              >
                <span aria-hidden="true">↗</span>
                <h3>
                  Not sure where
                  <br />
                  you fit?
                </h3>
                <p>
                  Tell us what you’re running and what you need. We’ll help you compare the options.
                </p>
                <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
                  Ask us about hosting <span aria-hidden="true">↗</span>
                </Link>
              </ScrollItem>
            </ScrollGroup>
            <p className="studio-pricing-note">
              All plans include hosting, SSL, monitoring, incident response, and a maintenance
              retainer for repairs and fixes to existing functionality. Your proposal defines the
              retainer coverage and included maintenance work. New features, redesigns, and work
              outside that scope are quoted separately, with additional development billed at{" "}
              <strong>$100–$150/hr</strong>.
            </p>
          </div>
        </section>
        <section className="studio-section page-wrap">
          <Reveal className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">BEFORE WE GET STARTED</p>
              <h2>
                A little clarity
                <br />
                <em>goes a long way.</em>
              </h2>
            </div>
          </Reveal>
          <Reveal className="studio-faq">
            {faqItems.map(({ question, answer }) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </Reveal>
        </section>
        <section className="studio-contact studio-inverse">
          <Reveal className="page-wrap">
            <p className="studio-eyebrow">LET’S FIND THE RIGHT STARTING POINT</p>
            <h2>
              What do you need
              <br />
              <em>to move forward?</em>
            </h2>
            <p>
              Bring the problem, the idea, or the process that isn’t working. We’ll help you explore
              your options.
            </p>
            <div className="studio-actions">
              <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
                Start the conversation <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </Reveal>
        </section>
      </div>
    </MotionRoot>
  );
}
