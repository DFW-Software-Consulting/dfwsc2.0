// Post-build step: renders the marketing routes to static HTML, writes the SPA shell and
// 404 page, and generates sitemap.xml. Called by the prerender plugin in vite.config.js
// after the client build and the `--ssr` build of src/entry-server.jsx.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function prerender() {
  const clientDir = join(root, "build-dist");
  const serverEntry = pathToFileURL(join(root, "build-ssr", "entry-server.js")).href;

  const HEAD_MARKER = "<!--seo-head-->";
  const ROOT_MARKER = '<div id="root"></div>';

  const { render, renderHead, NOT_FOUND_META, PUBLIC_ROUTES, SHELL_META, SITE_URL } = await import(
    serverEntry
  );

  const template = await readFile(join(clientDir, "index.html"), "utf8");
  for (const marker of [HEAD_MARKER, ROOT_MARKER]) {
    if (!template.includes(marker)) throw new Error(`index.html is missing ${marker}`);
  }

  const fill = (head, body = "") =>
    template.replace(HEAD_MARKER, head).replace(ROOT_MARKER, `<div id="root">${body}</div>`);

  // "/" -> index.html, "/pricing" -> pricing.html (nginx maps the clean URLs onto these).
  const fileFor = (path) => (path === "/" ? "index.html" : `${path.slice(1)}.html`);

  // Unrendered shell for portal routes; the client creates the root and sets the title.
  await writeFile(join(clientDir, "spa.html"), fill(renderHead(SHELL_META, "/")));

  // The not-found page, served by nginx with a real 404 status.
  await writeFile(
    join(clientDir, "404.html"),
    fill(renderHead(NOT_FOUND_META, "/404"), await render("/404"))
  );

  for (const path of Object.keys(PUBLIC_ROUTES)) {
    const html = fill(
      renderHead(PUBLIC_ROUTES[path], path, { jsonLd: true }),
      await render(path)
    );
    await writeFile(join(clientDir, fileFor(path)), html);
  }

  // lastmod is left out on purpose: build time says nothing about when a page changed.
  const urls = Object.keys(PUBLIC_ROUTES)
    .map((path) => `  <url>\n    <loc>${SITE_URL}${path === "/" ? "/" : path}</loc>\n  </url>`)
    .join("\n");
  await writeFile(
    join(clientDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );

  process.stdout.write(`Prerendered ${Object.keys(PUBLIC_ROUTES).length} routes, spa.html, 404.html, sitemap.xml` + "\n");
}
