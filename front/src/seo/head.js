import { canonicalUrl, OG_IMAGE, SITE_NAME, THEME_COLOR } from "./meta.js";

const meta = (key, value, content) => ({ tag: "meta", attrs: { [key]: value, content } });

/**
 * The managed head tags for a page, as `{ tag, attrs }`. Indexable pages get a canonical
 * and og/twitter URLs; every other page gets `robots: noindex, nofollow` instead.
 */
export function buildHead(page, pathname) {
  const { title, description, indexable } = page;
  const url = indexable ? canonicalUrl(pathname) : null;
  const tags = [
    meta("name", "description", description),
    meta("name", "theme-color", THEME_COLOR),
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", SITE_NAME),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    meta("property", "og:image", OG_IMAGE),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", title),
    meta("name", "twitter:description", description),
    meta("name", "twitter:image", OG_IMAGE),
  ];
  if (url) {
    tags.push(
      { tag: "link", attrs: { rel: "canonical", href: url } },
      meta("property", "og:url", url),
      meta("name", "twitter:url", url)
    );
  } else {
    tags.push(meta("name", "robots", "noindex,nofollow"));
  }
  return { title, tags };
}

/** CSS selector that finds the element for a tag again (one per name/property/rel). */
function tagSelector({ tag, attrs }) {
  if (tag === "link") return `link[rel="${attrs.rel}"]`;
  return attrs.name ? `meta[name="${attrs.name}"]` : `meta[property="${attrs.property}"]`;
}

// Every selector buildHead can emit, so a tag that no longer applies (the canonical when
// navigating to a private page, robots when navigating back) is removed.
const MANAGED_SELECTORS = [
  ...new Set(
    [
      buildHead({ title: "", description: "", indexable: true }, "/"),
      buildHead({ title: "", description: "", indexable: false }, "/"),
    ].flatMap(({ tags }) => tags.map(tagSelector))
  ),
];

/** Update the live document head in place: reuses prerendered tags, creates missing ones. */
export function applyHead(doc, { title, tags }) {
  doc.title = title;
  const wanted = new Map(tags.map((entry) => [tagSelector(entry), entry]));
  for (const selector of MANAGED_SELECTORS) {
    const existing = doc.head.querySelector(selector);
    const entry = wanted.get(selector);
    if (!entry) {
      existing?.remove();
      continue;
    }
    const element = existing ?? doc.head.appendChild(doc.createElement(entry.tag));
    for (const [name, value] of Object.entries(entry.attrs)) element.setAttribute(name, value);
  }
}
