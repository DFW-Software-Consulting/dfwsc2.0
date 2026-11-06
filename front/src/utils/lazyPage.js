import { createElement, lazy } from "react";

// When a preload error is suppressed (see preloadRecovery.js) Vite's helper
// resolves the import with undefined instead of rejecting. React's lazy would
// throw reading .default off it, so stay suspended until the reload lands.
//
// `preload()` starts the same import ahead of render. The browser entry awaits it before
// hydrating a prerendered page; once it has resolved the page renders directly instead of
// through `lazy`, which would suspend for a tick and leave the Suspense boundary
// dehydrated, where any other update (e.g. the stored theme) forces it to client-render.
export function lazyPage(load) {
  const Lazy = lazy(() => load().then((mod) => mod ?? new Promise(() => {})));
  let loaded = null;
  function Page(props) {
    return createElement(loaded ?? Lazy, props);
  }
  Page.preload = () =>
    load().then((mod) => {
      if (mod) loaded = mod.default;
      return mod;
    });
  return Page;
}
