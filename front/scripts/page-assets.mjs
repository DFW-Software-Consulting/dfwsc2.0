// Head links for a prerendered page's lazy chunk, built from the Vite build manifest.

/** Manifest key of the page module a public path renders: "/" -> Home, "/team" -> Team. */
export function pageKey(path) {
  return `src/pages/${path === "/" ? "Home" : path[1].toUpperCase() + path.slice(2)}.jsx`;
}

/**
 * `<link>` tags (joined by newlines) for the page's CSS and a modulepreload for its JS
 * chunks, following the chunk's static imports. Anything `template` already links (the
 * entry CSS and chunks) is skipped, so the tags are meant to go after the template's own
 * in `<head>`, which keeps the cascade order the runtime loader produced. Stylesheets come
 * before preloads. Returns "" when the chunk adds nothing. Throws when the manifest has no
 * entry for the page, so a renamed page fails the build instead of shipping unstyled HTML.
 */
export function pageAssets(manifest, path, template) {
  const key = pageKey(path);
  if (!manifest[key]) throw new Error(`Build manifest has no entry for ${key}`);
  const css = new Set();
  const js = new Set();
  const walk = (name) => {
    const chunk = manifest[name];
    if (!chunk || js.has(chunk.file)) return;
    js.add(chunk.file);
    for (const file of chunk.css ?? []) css.add(file);
    for (const dep of chunk.imports ?? []) walk(dep);
  };
  walk(key);
  const fresh = (file) => !template.includes(`/${file}"`);
  return [
    ...[...css].filter(fresh).map((f) => `<link rel="stylesheet" crossorigin href="/${f}" />`),
    ...[...js].filter(fresh).map((f) => `<link rel="modulepreload" crossorigin href="/${f}" />`),
  ].join("\n    ");
}
