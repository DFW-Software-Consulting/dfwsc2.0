// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBuild } from "../../scripts/verify-build.mjs";
import { PUBLIC_ROUTES } from "../seo/meta.js";

const dirs = [];
async function buildDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "verify-build-"));
  dirs.push(dir);
  for (const file of files) await writeFile(join(dir, file), "<h1>x</h1>");
  return dir;
}
const pageFiles = Object.keys(PUBLIC_ROUTES).map((p) =>
  p === "/" ? "index.html" : `${p.slice(1)}.html`
);
const others = ["spa.html", "404.html", "sitemap.xml"];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("verifyBuild", () => {
  it("requires /privacy as a public, prerendered page", () => {
    expect(PUBLIC_ROUTES["/privacy"]?.indexable).toBe(true);
  });

  it("passes when every public page and the shell files exist", async () => {
    await expect(verifyBuild(await buildDir([...pageFiles, ...others]))).resolves.toBeUndefined();
  });

  it("fails for each public page that is missing, including privacy.html", async () => {
    for (const missing of pageFiles) {
      const dir = await buildDir([...pageFiles, ...others].filter((f) => f !== missing));
      await expect(verifyBuild(dir), missing).rejects.toThrow(missing);
    }
  });
});
