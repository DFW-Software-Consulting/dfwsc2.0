// Fails unless the build output holds the prerendered pages nginx routes to. Without them
// nginx would 404 real pages or serve an empty shell, so this guards the Docker build.
// Run from prerender.mjs, and directly (`node scripts/verify-build.mjs [dir]`) in the Dockerfile.
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileFor, PUBLIC_ROUTES } from "../src/seo/meta.js";

const EXTRA = ["spa.html", "404.html", "sitemap.xml"];

export async function verifyBuild(dir) {
  const pages = Object.keys(PUBLIC_ROUTES).map(fileFor);
  for (const file of [...pages, ...EXTRA]) {
    try {
      await access(join(dir, file));
    } catch {
      throw new Error(`Build check failed: ${file} is missing from ${dir}`);
    }
  }
  for (const file of pages) {
    const html = await readFile(join(dir, file), "utf8");
    if (!html.includes("<h1")) {
      throw new Error(`Build check failed: ${file} has no <h1>, so it was not prerendered`);
    }
    if (!/<link[^>]+rel="canonical"/.test(html)) {
      throw new Error(`Build check failed: ${file} has no canonical link`);
    }
    // The entry CSS plus the page's own lazy-chunk CSS; without the latter the first paint is unstyled.
    if ((html.match(/<link[^>]+rel="stylesheet"/g) ?? []).length < 2) {
      throw new Error(`Build check failed: ${file} does not link its page stylesheet`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "build-dist"));
  await verifyBuild(dir);
  process.stdout.write(`Build check passed for ${dir}\n`);
}
