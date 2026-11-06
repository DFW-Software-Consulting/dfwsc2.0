import { useEffect } from "react";
import { Link } from "react-router-dom";
import CtaStrip from "../components/CtaStrip.jsx";
import Disclosure from "../components/Disclosure.jsx";
import HeroHeading from "../components/motion/HeroHeading.jsx";
import { MotionRoot, RevealGroup, RevealItem } from "../components/motion/Reveal.jsx";
import {
  LEAVE,
  PAGE_HERO,
  ScrollFx,
  ScrollGroup,
  ScrollItem,
  ScrollRule,
} from "../components/motion/ScrollFx.jsx";
import SectionHeading from "../components/motion/SectionHeading.jsx";
import { useSpotlight } from "../components/motion/useTilt.js";
import { faqItems, hostingPlans, retainer } from "../content/pricing.js";
import "../styles/studio.css";
import "./Pricing.css";

export default function Pricing() {
  const spotlight = useSpotlight();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <MotionRoot>
      <div className="studio studio-page">
        <section className="studio-page-hero">
          <ScrollFx offset={LEAVE} fx={PAGE_HERO}>
            <RevealGroup mount className="page-wrap">
              <HeroHeading
                eyebrow="A GOOD FIT STARTS WITH A CLEAR PLAN"
                lead="The right support."
                accent="Room to grow."
              />
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
          <SectionHeading
            eyebrow="TWO WAYS TO BUILD WITH US"
            lead="A project today."
            accent="A partner tomorrow."
          >
            Start with a defined piece of work, or make us part of your team. We’ll discuss scope,
            priorities, and costs before work begins.
          </SectionHeading>
          <ScrollRule />
          <ScrollGroup className="studio-engagement-grid">
            <ScrollItem
              as="article"
              className="studio-engagement-card studio-spot studio-lift"
              index={0}
              count={2}
              {...spotlight}
            >
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
              </ul>
            </ScrollItem>
            <ScrollItem
              as="article"
              className="studio-engagement-card studio-engagement-featured studio-inverse studio-spot studio-lift"
              index={1}
              count={2}
              {...spotlight}
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
              <ul>
                <li>For growing products that need a consistent team</li>
                <li>Priorities, available hours, and scope worked through together</li>
              </ul>
            </ScrollItem>
          </ScrollGroup>
        </section>
        <section id="hosting" className="studio-band">
          <div className="page-wrap">
            <SectionHeading
              eyebrow="HOSTING & MAINTENANCE"
              lead="A home for"
              accent="what you build."
            >
              Each monthly price includes hosting and a maintenance retainer for repairs and fixes
              to your existing website or application. New builds and features are quoted
              separately.
            </SectionHeading>
            <ScrollGroup className="studio-plan-grid">
              {hostingPlans.map((plan, index) => (
                <ScrollItem
                  as="article"
                  className="studio-plan-card studio-spot studio-lift"
                  key={plan.name}
                  index={index}
                  count={hostingPlans.length}
                  {...spotlight}
                >
                  <h3>{plan.name}</h3>
                  <p className="studio-plan-price">
                    {plan.price} <span>/ month</span>
                  </p>
                  <p className="studio-plan-fit">{plan.idealFor}</p>
                </ScrollItem>
              ))}
            </ScrollGroup>
            <Disclosure summary="Compare allowances" className="studio-allowances">
              <div className="studio-allowance-grid">
                {hostingPlans.map((plan) => (
                  <section key={plan.name}>
                    <h3>{plan.name}</h3>
                    <dl className="studio-plan-specs">
                      {plan.specs.map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="studio-plan-includes">{plan.includes}</p>
                  </section>
                ))}
              </div>
            </Disclosure>
          </div>
        </section>
        <section className="studio-section page-wrap">
          <SectionHeading
            eyebrow="BEFORE WE GET STARTED"
            lead="A little clarity"
            accent="goes a long way."
          />
          <div className="studio-faq">
            {faqItems.map(({ question, answer }) => (
              <Disclosure key={question} summary={question}>
                <p>{answer}</p>
              </Disclosure>
            ))}
          </div>
        </section>
        <CtaStrip title="What do you need to move forward?" label="Start the conversation" />
      </div>
    </MotionRoot>
  );
}
