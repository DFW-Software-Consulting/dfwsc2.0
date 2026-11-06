import { Writable } from "node:stream";
import { QueryClient } from "@tanstack/react-query";
import { renderToPipeableStream } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import App from "./App.jsx";
import Root from "./Root.jsx";

export { NOT_FOUND_META, PUBLIC_ROUTES, SHELL_META, SITE_URL } from "./seo/meta.js";
export { renderHead } from "./seo/render.js";

/**
 * Render the app at `url` to an HTML string. Waits for every lazy route module so the
 * output holds the real page, never a Suspense fallback.
 */
export function render(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      },
      final(done) {
        resolve(Buffer.concat(chunks).toString("utf8"));
        done();
      },
    });
    const { pipe } = renderToPipeableStream(
      <Root queryClient={new QueryClient()} hydrating>
        <StaticRouter location={url}>
          <App />
        </StaticRouter>
      </Root>,
      {
        onAllReady: () => pipe(sink),
        onShellError: reject,
        onError: reject,
      }
    );
  });
}
