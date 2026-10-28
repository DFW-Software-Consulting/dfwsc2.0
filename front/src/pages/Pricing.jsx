import { useEffect } from "react";
import { Link } from "react-router-dom";
import "./StudioHome.css";
import "./StudioPages.css";

const plans = [
  {
    name: "Basic Hosting",
    price: "$40 / mo",
    includes: "Hosting + uptime monitoring, minor edits, payment setup",
    idealFor: "Business websites and landing pages",
    specs: [
      ["Website & file storage", "5 GB"],
      ["Monthly data transfer", "100 GB"],
      ["Database storage", "Not included"],
      ["Application backend", "Not included"],
      ["Maintenance retainer", "Included"],
      ["Support", "Standard"],
    ],
  },
  {
    name: "Pro Hosting",
    price: "$100 / mo",
    includes:
      "Multi-page site hosting, domain management, maintenance, backups, backend API hosting, and database storage — we keep it running so you don't have to",
    idealFor: "Custom applications and client portals",
    specs: [
      ["Website & file storage", "10 GB"],
      ["Monthly data transfer", "500 GB"],
      ["Database storage", "1 GB"],
      ["Application backend", "Included"],
      ["Maintenance retainer", "Included"],
      ["Support", "Standard"],
    ],
  },
  {
    name: "Business Hosting",
    price: "$200 / mo",
    includes:
      "Application hosting, maintenance, backups, monthly performance review, and priority support for businesses with more demanding storage and processing needs",
    idealFor: "Businesses with larger applications and data needs",
    specs: [
      ["Website & file storage", "25 GB"],
      ["Monthly data transfer", "1 TB"],
      ["Database storage", "5 GB"],
      ["Application backend", "Included"],
      ["Maintenance retainer", "Included"],
      ["Support", "Priority"],
    ],
  },
  {
    name: "Dev Retainer",
    price: "Custom",
    includes: "Ongoing dev team, new features, priority support, and dedicated engineering hours",
    idealFor: "Growing products that need a consistent team",
    cta: true,
  },
];

export default function Pricing() {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  const retainer = plans.find((plan) => plan.cta);
  return (
    <div className="studio studio-page">
      <section className="studio-page-hero">
        <div className="studio-wrap">
          <p className="studio-eyebrow">A GOOD FIT STARTS WITH A CLEAR PLAN</p>
          <h1>
            The right support.
            <br />
            <em>Room to grow.</em>
          </h1>
          <p>
            From a single project to your ongoing development team, choose the kind of partnership
            your business needs.
          </p>
          <div className="studio-actions">
            <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
              Talk through your options <span aria-hidden="true">↗</span>
            </Link>
            <a className="studio-text-link" href="#hosting">
              See hosting plans <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
      </section>
      <section className="studio-section studio-wrap">
        <div className="studio-section-heading">
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
        </div>
        <div className="studio-engagement-grid">
          <article className="studio-engagement-card">
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
          </article>
          <article className="studio-engagement-card studio-engagement-featured">
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
          </article>
        </div>
      </section>
      <section id="hosting" className="studio-hosting-section">
        <div className="studio-wrap">
          <div className="studio-section-heading">
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
          </div>
          <p className="studio-allowance-draft">
            Proposed allowances for review. Final storage, data transfer, and processing limits will
            be confirmed in your hosting proposal.
          </p>
          <div className="studio-plan-grid">
            {plans
              .filter((plan) => !plan.cta)
              .map((plan) => (
                <article className="studio-plan-card" key={plan.name}>
                  <h3>{plan.name}</h3>
                  <p className="studio-plan-price">
                    {plan.price.split(" ")[0]} <span>/ month</span>
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
                </article>
              ))}
            <article className="studio-plan-help">
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
            </article>
          </div>
          <p className="studio-pricing-note">
            All plans include hosting, SSL, monitoring, incident response, and a maintenance
            retainer for repairs and fixes to existing functionality. Your proposal defines the
            retainer coverage and included maintenance work. New features, redesigns, and work
            outside that scope are quoted separately, with additional development billed at{" "}
            <strong>$100–$150/hr</strong>.
          </p>
        </div>
      </section>
      <section className="studio-section studio-wrap">
        <div className="studio-section-heading">
          <div>
            <p className="studio-eyebrow">BEFORE WE GET STARTED</p>
            <h2>
              A little clarity
              <br />
              <em>goes a long way.</em>
            </h2>
          </div>
        </div>
        <div className="studio-faq">
          <details>
            <summary>What do storage and monthly data transfer mean?</summary>
            <p>
              Storage is the space used by your website and uploaded files. Database storage is
              listed separately for application records. Monthly data transfer is the amount of data
              delivered to visitors, including pages, images, and downloads. It resets each billing
              month and is not a visitor limit.
            </p>
          </details>
          <details>
            <summary>What happens if my business needs more capacity?</summary>
            <p>
              Your hosting proposal will specify your included allowances and how additional usage
              is billed. More storage, data transfer, or application processing may require
              additional infrastructure charges or a different plan. Email, video delivery,
              third-party services, and AI usage are scoped separately.
            </p>
          </details>
          <details>
            <summary>Does hosting include building my website?</summary>
            <p>
              A new website or application is quoted separately. The monthly hosting price includes
              a maintenance retainer for repairs and fixes to existing functionality, within the
              scope agreed in your proposal. New features and larger changes are estimated
              separately.
            </p>
          </details>
          <details>
            <summary>How do we decide the project price?</summary>
            <p>
              We start with your goals, required features, and current tools. A discovery
              conversation helps us define the scope, estimate the work, and explain the proposed
              costs.
            </p>
          </details>
          <details>
            <summary>Can you work with a website or application we already have?</summary>
            <p>
              Tell us what you’re using and where you need help. We’ll review the setup with you
              before recommending improvements or a migration path.
            </p>
          </details>
          <details>
            <summary>Can we keep working together after launch?</summary>
            <p>
              Yes. Every hosting plan includes a maintenance retainer for agreed repairs and fixes.
              If you need ongoing new features or dedicated development hours, we can discuss a
              separate development retainer.
            </p>
          </details>
        </div>
      </section>
      <section className="studio-contact">
        <div className="studio-wrap">
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
        </div>
      </section>
    </div>
  );
}
