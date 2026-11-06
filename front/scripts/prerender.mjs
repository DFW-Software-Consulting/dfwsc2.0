// Post-build step: renders the marketing routes to static HTML, writes the SPA shell and
// 404 page, and generates sitemap.xml. Called by the prerender plugin in vite.config.js
// after the client build and the `--ssr` build of src/entry-server.jsx.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileFor } from "../src/seo/meta.js";
import { pageAssets } from "./page-assets.mjs";
import { verifyBuild } from "./verify-build.mjs";

/** `clientDir`: the client build output; `serverDir`: the `--ssr` build output. */
export async function prerender({ clientDir, serverDir }) {
  const serverEntry = pathToFileURL(join(serverDir, "entry-server.js")).href;

  const HEAD_MARKER = "<!--seo-head-->";
  const ROOT_MARKER = '<div id="root"></div>';

  const { render, renderHead, NOT_FOUND_META, PUBLIC_ROUTES, SHELL_META, SITE_URL } = await import(
    serverEntry
  );

  const template = await readFile(join(clientDir, "index.html"), "utf8");
  for (const marker of [HEAD_MARKER, ROOT_MARKER]) {
    if (!template.includes(marker)) throw new Error(`index.html is missing ${marker}`);
  }

  // The page chunks are lazy, so Vite only adds their CSS at runtime. Without it in the
  // HTML the first paint is unstyled and the page jumps once the CSS lands (CLS). Link the
  // route's CSS and preload its JS so both arrive with the document.
  const manifest = JSON.parse(await readFile(join(clientDir, ".vite", "manifest.json"), "utf8"));
  const pageLinks = (path) => pageAssets(manifest, path, template);

  const fill = (head, body = "", assets = "") =>
    template
      .replace(HEAD_MARKER, head)
      .replace("</head>", assets ? `  ${assets}\n  </head>` : "</head>")
      .replace(ROOT_MARKER, `<div id="root">${body}</div>`);

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
      await render(path),
      pageLinks(path)
    );
    await writeFile(join(clientDir, fileFor(path)), html);
  }

  // lastmod is left out on purpose: build time says nothing about when a page changed.
  const urls = Object.keys(PUBLIC_ROUTES)
    .map((path) => `  <url>\n    <loc>${SITE_URL}${path}</loc>\n  </url>`)
    .join("\n");
  await writeFile(
    join(clientDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );

  process.stdout.write(`Prerendered ${Object.keys(PUBLIC_ROUTES).length} routes, spa.html, 404.html, sitemap.xml` + "\n");

  await rm(join(clientDir, ".vite"), { recursive: true, force: true });
  await verifyBuild(clientDir);
}
