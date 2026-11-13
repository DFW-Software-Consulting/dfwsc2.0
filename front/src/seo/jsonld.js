import { faqItems, hostingPlans, retainer } from "../content/pricing.js";
import { teamMembers } from "../content/team.js";
import { normalizePath, OG_IMAGE, SITE_NAME, SITE_URL } from "./meta.js";

// Structured data, built only from facts that already exist on the site (contact details,
// plans, FAQ and team data). Build-time only: nothing here ships in the client bundle.

const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;
const GITHUB_URL = "https://github.com/DFW-Software-Consulting";

const dollars = (price) => Number(price.replace(/[^0-9.]/g, ""));
const planPrices = hostingPlans.map((plan) => dollars(plan.price));

const organization = {
  "@type": "ProfessionalService",
  "@id": ORGANIZATION_ID,
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  logo: OG_IMAGE,
  image: OG_IMAGE,
  description:
    "Websites, custom software, and simpler workflows for small businesses. Based in Dallas–Fort Worth, working with businesses everywhere.",
  telephone: "+1-214-326-0128",
  email: "mail@dfwsc.com",
  address: {
    "@type": "PostalAddress",
    postOfficeBoxNumber: "411123",
    addressLocality: "Dallas",
    addressRegion: "TX",
    postalCode: "75241",
    addressCountry: "US",
  },
  areaServed: { "@type": "AdministrativeArea", name: "Dallas–Fort Worth" },
  priceRange: `$${Math.min(...planPrices)}–$${Math.max(...planPrices)} per month`,
  sameAs: [GITHUB_URL],
};

const website = {
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  url: `${SITE_URL}/`,
  name: SITE_NAME,
  publisher: { "@id": ORGANIZATION_ID },
};

function pricingPage() {
  const planOffers = hostingPlans.map((plan) => ({
    "@type": "Offer",
    name: plan.name,
    description: plan.includes,
    price: dollars(plan.price),
    priceCurrency: "USD",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: dollars(plan.price),
      priceCurrency: "USD",
      unitCode: "MON",
      billingDuration: 1,
    },
    itemOffered: {
      "@type": "Service",
      name: plan.name,
      audience: { "@type": "Audience", audienceType: plan.idealFor },
    },
  }));
  return {
    organization: {
      hasOfferCatalog: {
        "@type": "OfferCatalog",
        name: "Hosting and maintenance plans",
        itemListElement: [
          ...planOffers,
          // Intentionally unpriced: the retainer is quoted, so it is a Service, not an Offer.
          {
            "@type": "Service",
            name: retainer.name,
            description: retainer.includes,
          },
        ],
      },
    },
    nodes: [
      {
        "@type": "FAQPage",
        mainEntity: faqItems.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: { "@type": "Answer", text: answer },
        })),
      },
    ],
  };
}

function teamPage() {
  return {
    nodes: teamMembers.map((member) => ({
      "@type": "Person",
      name: member.name,
      jobTitle: member.role,
      description: member.bio,
      worksFor: { "@id": ORGANIZATION_ID },
      ...(member.linkedin ? { sameAs: [member.linkedin] } : {}),
    })),
  };
}

const PAGES = { "/pricing": pricingPage, "/team": teamPage };

/**
 * The JSON-LD document for an indexable path: the organisation (extended with the page's
 * own properties, so it stays a single node) and website, plus the page's other nodes.
 */
export function buildJsonLd(pathname) {
  const page = PAGES[normalizePath(pathname)]?.();
  return {
    "@context": "https://schema.org",
    "@graph": [{ ...organization, ...page?.organization }, website, ...(page?.nodes ?? [])],
  };
}
