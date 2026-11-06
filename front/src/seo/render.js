import { buildHead } from "./head.js";
import { buildJsonLd } from "./jsonld.js";

// Build-time only: serialises head tags and JSON-LD to the HTML injected into each
// prerendered file.

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const renderTag = ({ tag, attrs }) =>
  `<${tag} ${Object.entries(attrs)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ")} />`;

/** `<title>`, managed meta/link tags and (optionally) a JSON-LD script, as one string. */
export function renderHead(page, pathname, { jsonLd = false } = {}) {
  const { title, tags } = buildHead(page, pathname);
  const lines = [`<title>${escapeHtml(title)}</title>`, ...tags.map(renderTag)];
  if (jsonLd) {
    // "<" is escaped so the data can never close the script element.
    const json = JSON.stringify(buildJsonLd(pathname)).replace(/</g, "\\u003c");
    lines.push(`<script type="application/ld+json">${json}</script>`);
  }
  return lines.join("\n    ");
}
