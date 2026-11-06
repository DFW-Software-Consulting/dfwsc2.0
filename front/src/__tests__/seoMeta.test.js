import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { faqItems, hostingPlans } from "../content/pricing.js";
import { teamMembers } from "../content/team.js";
import { routes } from "../routes.js";
import { applyHead, buildHead } from "../seo/head.js";
import { buildJsonLd } from "../seo/jsonld.js";
import {
  canonicalUrl,
  NOT_FOUND_META,
  normalizePath,
  PRIVATE_PATHS,
  PUBLIC_ROUTES,
  resolveMeta,
} from "../seo/meta.js";
import { renderHead } from "../seo/render.js";

const tag = (head, selector) => head.tags.find((t) => `${t.tag}` && matches(t, selector));
const matches = ({ tag: name, attrs }, selector) =>
  selector === "canonical"
    ? name === "link" && attrs.rel === "canonical"
    : (attrs.name ?? attrs.property) === selector;

describe("route metadata", () => {
  it("gives every public route a keyword-bearing title and a description of sensible length", () => {
    for (const [path, page] of Object.entries(PUBLIC_ROUTES)) {
      expect(page.indexable, path).toBe(true);
      expect(page.title, path).toContain("DFW Software Consulting");
      expect(page.description.length, path).toBeGreaterThan(100);
      expect(page.description.length, path).toBeLessThanOrEqual(170);
    }
    expect(PUBLIC_ROUTES["/"].title).toMatch(/Dallas–Fort Worth/);
  });

  it("keeps portal routes and unknown paths out of the index", () => {
    for (const path of PRIVATE_PATHS) expect(resolveMeta(path).indexable, path).toBe(false);
    expect(resolveMeta("/does-not-exist")).toBe(NOT_FOUND_META);
    expect(NOT_FOUND_META.indexable).toBe(false);
  });

  it("normalises case and trailing slashes", () => {
    expect(normalizePath("/Pricing/")).toBe("/pricing");
    expect(normalizePath("")).toBe("/");
    expect(resolveMeta("/team/")).toBe(PUBLIC_ROUTES["/team"]);
    expect(canonicalUrl("/pricing/")).toBe("https://dfwsc.com/pricing");
    expect(canonicalUrl("/")).toBe("https://dfwsc.com/");
  });

  it("covers every route in the route table exactly once", () => {
    const known = new Set([...Object.keys(PUBLIC_ROUTES), ...PRIVATE_PATHS, "*"]);
    expect(new Set(routes.map((r) => r.path))).toEqual(known);
  });
});

describe("buildHead", () => {
  it("emits a canonical and social URLs for indexable pages, and no robots tag", () => {
    const head = buildHead(PUBLIC_ROUTES["/pricing"], "/pricing");
    expect(head.title).toBe(PUBLIC_ROUTES["/pricing"].title);
    expect(tag(head, "canonical").attrs.href).toBe("https://dfwsc.com/pricing");
    expect(tag(head, "og:url").attrs.content).toBe("https://dfwsc.com/pricing");
    expect(tag(head, "twitter:url").attrs.content).toBe("https://dfwsc.com/pricing");
    expect(tag(head, "og:title").attrs.content).toBe(head.title);
    expect(tag(head, "og:site_name").attrs.content).toBe("DFW Software Consulting");
    expect(tag(head, "theme-color").attrs.content).toBe("#2c6daf");
    expect(tag(head, "robots")).toBeUndefined();
  });

  it("emits noindex,nofollow and no canonical for non-indexable pages", () => {
    const head = buildHead(NOT_FOUND_META, "/nope");
    expect(tag(head, "robots").attrs.content).toBe("noindex,nofollow");
    expect(tag(head, "canonical")).toBeUndefined();
    expect(tag(head, "og:url")).toBeUndefined();
  });
});

describe("applyHead", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.title = "";
  });

  it("updates tags in place and never duplicates them across navigations", () => {
    applyHead(document, buildHead(PUBLIC_ROUTES["/"], "/"));
    applyHead(document, buildHead(PUBLIC_ROUTES["/team"], "/team"));

    expect(document.title).toBe(PUBLIC_ROUTES["/team"].title);
    expect(document.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="description"]').content).toBe(
      PUBLIC_ROUTES["/team"].description
    );
    expect(document.querySelector('link[rel="canonical"]').href).toBe("https://dfwsc.com/team");
    expect(document.querySelector('meta[property="og:url"]').content).toBe(
      "https://dfwsc.com/team"
    );
  });

  it("adopts prerendered tags instead of adding second copies", () => {
    document.head.innerHTML = renderHead(PUBLIC_ROUTES["/pricing"], "/pricing", { jsonLd: true });
    const before = document.head.querySelectorAll("meta, link").length;
    applyHead(document, buildHead(PUBLIC_ROUTES["/pricing"], "/pricing"));
    expect(document.head.querySelectorAll("meta, link")).toHaveLength(before);
  });

  it("swaps canonical for noindex when moving to a private page, and back", () => {
    applyHead(document, buildHead(PUBLIC_ROUTES["/"], "/"));
    applyHead(document, buildHead(resolveMeta("/admin"), "/admin"));
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
    expect(document.querySelector('meta[name="robots"]').content).toBe("noindex,nofollow");

    applyHead(document, buildHead(PUBLIC_ROUTES["/pricing"], "/pricing"));
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.querySelector('link[rel="canonical"]').href).toBe("https://dfwsc.com/pricing");
  });
});

describe("JSON-LD", () => {
  const nodes = (path) => buildJsonLd(path)["@graph"];
  const ofType = (path, type) => nodes(path).filter((n) => n["@type"] === type);

  it("includes the organisation and website on every page, from facts already on the site", () => {
    const [org] = ofType("/", "ProfessionalService");
    expect(org.name).toBe("DFW Software Consulting");
    expect(org.telephone).toBe("+1-214-326-0128");
    expect(org.email).toBe("mail@dfwsc.com");
    expect(org.areaServed.name).toBe("Dallas–Fort Worth");
    expect(org.priceRange).toBe("$40–$200 per month");
    expect(ofType("/team", "WebSite")).toHaveLength(1);
    expect(org).not.toHaveProperty("address");
  });

  it("builds the pricing FAQPage from the same data the page renders", () => {
    const [faq] = ofType("/pricing", "FAQPage");
    expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(
      faqItems.map(({ question, answer }) => [question, answer])
    );
    expect(faqItems.length).toBeGreaterThan(0);
  });

  it("lists each hosting plan with its monthly price", () => {
    expect(ofType("/pricing", "ProfessionalService")).toHaveLength(1);
    const catalog = ofType("/pricing", "ProfessionalService")[0];
    const offers = catalog.hasOfferCatalog.itemListElement;
    for (const plan of hostingPlans) {
      const offer = offers.find((o) => o.name === plan.name);
      expect(offer.price).toBe(Number(plan.price.slice(1)));
      expect(offer.priceCurrency).toBe("USD");
    }
  });

  it("lists the team as people working for the organisation", () => {
    const people = ofType("/team", "Person");
    expect(people.map((p) => p.name)).toEqual(teamMembers.map((m) => m.name));
    for (const person of people) {
      expect(person.worksFor["@id"]).toBe("https://dfwsc.com/#organization");
    }
  });

  it("does not add page-specific nodes elsewhere", () => {
    expect(ofType("/", "FAQPage")).toHaveLength(0);
    expect(ofType("/", "Person")).toHaveLength(0);
  });
});

describe("renderHead", () => {
  it("escapes attribute values and keeps JSON-LD from closing its script element", () => {
    const html = renderHead(
      { title: 'A "quoted" <title> & more', description: "x</script>", indexable: true },
      "/pricing",
      { jsonLd: true }
    );
    expect(html).toContain("<title>A &quot;quoted&quot; &lt;title&gt; &amp; more</title>");
    expect(html).toContain('<script type="application/ld+json">');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("nginx.conf stays in step with the route config", () => {
  const conf = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "nginx.conf"),
    "utf-8"
  );

  it("serves every portal route as the noindex SPA shell", () => {
    const [, alternation] = conf.match(
      /location ~ \^\/\(([^)]*)\)\/\?\$ \{\s*try_files \/spa\.html/
    );
    expect(alternation.split("|").sort()).toEqual(PRIVATE_PATHS.map((p) => p.slice(1)).sort());
  });

  it("serves every prerendered page at its clean URL", () => {
    const [, alternation] = conf.match(/location ~ \^\/\(([^)]*)\)\$ \{\s*try_files \/\$1\.html/);
    const expected = Object.keys(PUBLIC_ROUTES)
      .filter((p) => p !== "/")
      .map((p) => p.slice(1));
    expect(alternation.split("|").sort()).toEqual(expected.sort());
  });

  it("redirects /docs, /docs/ and /docs.html to the Nextcloud guide with a 301", () => {
    const [, pattern, target] = conf.match(
      /location ~ (\^\/docs[^\s]*) \{\s*return 301 (https:\/\/\S+);/
    );
    const re = new RegExp(pattern.replace(/\\\./g, "\\."));
    for (const path of ["/docs", "/docs/", "/docs.html"]) expect(path).toMatch(re);
    expect(target).toBe("https://cloud.dfwsc.com/apps/collectives/Developer-Integration-Guide-4");
    expect(Object.keys(PUBLIC_ROUTES)).not.toContain("/docs");
  });

  it("never sets add_header inside a location (it would drop the security headers)", () => {
    const inLocations = conf.split("\n").filter((line) => /^\s{8,}add_header /.test(line));
    expect(inLocations).toEqual([]);
  });
});
