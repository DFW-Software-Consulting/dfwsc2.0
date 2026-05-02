import { Link } from "react-router-dom";
import Banner from "../components/Banner.jsx";

const plans = [
  {
    name: "Starter Hosting",
    price: "$20 / mo",
    includes: "Static landing page hosting, SSL, CDN, domain setup",
    idealFor: "Portfolios, promo pages",
  },
  {
    name: "Basic Hosting",
    price: "$40 / mo",
    includes: "Hosting + uptime monitoring, minor edits, payment setup",
    idealFor: "Small business sites",
  },
  {
    name: "Standard Hosting",
    price: "$75 / mo",
    includes: "Multi-page site hosting, domain management, and a small database included — you manage your own updates and changes",
    idealFor: "Multi-page business sites with basic data needs",
  },
  {
    name: "Pro Hosting",
    price: "$100 / mo",
    includes: "Everything in Standard plus maintenance, backups, backend API hosting, and expanded database — we keep it running so you don't have to",
    idealFor: "Full-stack apps and client portals",
  },
  {
    name: "High-Traffic Hosting",
    price: "$200 / mo",
    includes:
      "CDN caching tuned for volume, monthly performance review, priority queue if something breaks, and we proactively tell you when you're about to hit a wall",
    idealFor: "High-traffic sites and scaling products",
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
  return (
    <div className="mx-auto w-full max-w-6xl space-y-24 px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300">
      <section className="mx-auto max-w-4xl text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/20 bg-brand-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-800 dark:text-brand-300">
          Hosting & Maintenance
        </span>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl text-gradient">
          Predictable pricing for platforms you can depend on
        </h1>
        <p className="mt-8 text-xl text-[var(--text-muted)] leading-relaxed transition-colors">
          Every plan includes SSL, global CDN delivery, and DFWSC-managed updates so you can focus
          on customers.
        </p>
      </section>

      <Banner
        className="mt-12 glass rounded-2xl p-4 text-center border-brand-500/20 shadow-sm"
        message="🌐 From cloud migrations to compliance-ready hosting, our bench of engineers has your infrastructure on lock."
      />

      <section className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => (
          <article
            key={plan.name}
            className="group relative flex flex-col rounded-[2rem] border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-8 transition-all duration-500 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:border-brand-500/30 hover:-translate-y-1 hover:shadow-glow shadow-sm"
          >
            <div className="mb-6 transition-colors">
              <h2 className="text-xl font-bold text-[var(--text-main)] group-hover:text-brand-600 dark:group-hover:text-brand-200 transition-colors">
                {plan.name}
              </h2>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {plan.cta ? (
                  <span className="text-4xl font-black text-brand-500 transition-colors">
                    Custom
                  </span>
                ) : (
                  <>
                    <span className="text-4xl font-black text-[var(--text-main)] transition-colors">
                      {plan.price.split(" ")[0]}
                    </span>
                    <span className="text-sm font-medium text-[var(--text-muted)] transition-colors">
                      / {plan.price.split(" ")[2]}
                    </span>
                  </>
                )}
              </div>
              <div className="h-4" />
            </div>

            <div className="mt-auto pt-8 border-t border-slate-200 dark:border-white/5">
              <p className="text-sm text-[var(--text-muted)] leading-relaxed min-h-[3rem] transition-colors">
                {plan.includes}
              </p>
              <div className="mt-6 flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  Ideal for:
                </span>
                <span className="text-[11px] font-semibold text-brand-600 dark:text-brand-300/90 transition-colors">
                  {plan.idealFor}
                </span>
              </div>
              {plan.cta && (
                <Link
                  to="/"
                  state={{ scrollTo: "contact" }}
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 px-6 py-3 text-sm font-bold text-white shadow-glow transition-all duration-300 hover:shadow-glow-strong hover:-translate-y-1 active:translate-y-0"
                >
                  Let&apos;s talk
                </Link>
              )}
            </div>
          </article>
        ))}
      </section>

      <div className="rounded-[2rem] border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)]/50 dark:bg-white/[0.01] p-6 text-center text-sm text-[var(--text-muted)] backdrop-blur-sm shadow-sm transition-colors">
        All hosting plans include DFWSC-managed uptime, SSL, monitoring, and incident response.
        Labor for devops and custom feature development is billed separately at $100–$150/hr.
      </div>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="rounded-[2rem] border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-10 transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.04] shadow-sm">
          <h2 className="text-3xl font-bold text-[var(--text-main)] transition-colors">
            Project Kickoffs
          </h2>
          <p className="mt-6 text-lg text-[var(--text-muted)] leading-relaxed transition-colors">
            Need a new build or major feature? We start with a short discovery workshop to define
            scope, handoff plan, and success metrics.
          </p>
          <ul className="mt-10 space-y-5">
            {[
              "2–6 week MVP timelines with weekly previews and async updates.",
              "Clear documentation so you can run in-house or keep us on retainer.",
              "Integrations with Stripe and analytics platforms baked in.",
            ].map((item) => (
              <li key={item} className="flex items-start gap-4 group">
                <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/10 border border-brand-500/20 group-hover:border-brand-500/40 transition-colors">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                </div>
                <span className="text-base text-[var(--text-muted)] transition-colors">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col justify-between rounded-[2rem] border border-brand-500/10 bg-gradient-to-br from-brand-600/5 to-transparent dark:from-brand-600/10 dark:to-transparent p-10 transition-all duration-300 hover:from-brand-600/10 dark:hover:bg-white/[0.04] shadow-sm">
          <div>
            <h2 className="text-3xl font-bold text-[var(--text-main)] transition-colors">
              Let&apos;s pick the right plan
            </h2>
            <p className="mt-6 text-lg text-[var(--text-muted)] leading-relaxed transition-colors">
              Tell us about the app, traffic expectations, and compliance needs. We&apos;ll
              recommend an environment and share a migration path if you&apos;re moving from an
              existing host.
            </p>
          </div>
          <Link
            to="/"
            state={{ scrollTo: "contact" }}
            className="mt-12 inline-flex w-full sm:w-fit items-center justify-center gap-2 rounded-full bg-brand-500 px-10 py-4 text-base font-bold text-white shadow-glow transition-all duration-300 hover:shadow-glow-strong hover:-translate-y-1 active:translate-y-0"
          >
            Start the conversation
          </Link>
        </div>
      </section>
    </div>
  );
}
