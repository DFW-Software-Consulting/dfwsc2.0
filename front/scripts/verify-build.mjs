// Fails unless the build output holds the prerendered pages nginx routes to. Without them
// nginx would 404 real pages or serve an empty shell, so this guards the Docker build.
// Run from prerender.mjs, and directly (`node scripts/verify-build.mjs [dir]`) in the Dockerfile.
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED = [
  "index.html",
  "pricing.html",
  "team.html",
  "privacy.html",
  "docs.html",
  "spa.html",
  "404.html",
  "sitemap.xml",
];

export async function verifyBuild(dir) {
  for (const file of REQUIRED) {
    try {
      await access(join(dir, file));
    } catch {
      throw new Error(`Build check failed: ${file} is missing from ${dir}`);
    }
  }
  const pricing = await readFile(join(dir, "pricing.html"), "utf8");
  if (!pricing.includes("<h1")) {
    throw new Error("Build check failed: pricing.html has no <h1>, so it was not prerendered");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "build-dist"));
  await verifyBuild(dir);
  process.stdout.write(`Build check passed for ${dir}\n`);
}
