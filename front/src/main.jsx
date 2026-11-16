import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import Root from "./Root.jsx";
import { preloadRoute } from "./routes.js";
import { handlePreloadError } from "./utils/preloadRecovery.js";
import { createQueryClient } from "./utils/queryClient.js";
import { initVisitContext } from "./utils/visitContext.js";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import "./index.css";

window.addEventListener("vite:preloadError", handlePreloadError);
initVisitContext();

const queryClient = createQueryClient();

const container = document.getElementById("root");
const prerendered = container.hasChildNodes();

const app = (
  <StrictMode>
    <Root
      queryClient={queryClient}
      hydrating={prerendered}
      devtools={import.meta.env.DEV ? <ReactQueryDevtools /> : null}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Root>
  </StrictMode>
);

if (prerendered) {
  // Prerendered page: load the matched route's chunk first so its Suspense boundary
  // hydrates in place instead of falling back over the server HTML.
  preloadRoute(window.location.pathname)
    .catch(() => {})
    .then(() => hydrateRoot(container, app));
} else {
  createRoot(container).render(app);
}
