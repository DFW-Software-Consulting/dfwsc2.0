// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBuild } from "../../scripts/verify-build.mjs";
import { fileFor, PUBLIC_ROUTES } from "../seo/meta.js";

const PAGE =
  '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><link rel="canonical" href="https://dfwsc.com/"><h1>x</h1>';
const dirs = [];
async function buildDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "verify-build-"));
  dirs.push(dir);
  for (const file of files) await writeFile(join(dir, file), PAGE);
  return dir;
}
const pageFiles = Object.keys(PUBLIC_ROUTES).map(fileFor);
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

  it("fails when a page links only the entry stylesheet", async () => {
    const dir = await buildDir([...pageFiles, ...others]);
    await writeFile(
      join(dir, "pricing.html"),
      '<link rel="stylesheet" href="/a.css"><link rel="canonical" href="x"><h1>x</h1>'
    );
    await expect(verifyBuild(dir)).rejects.toThrow(
      "pricing.html does not link its page stylesheet"
    );
  });
});
