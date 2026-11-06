import { QueryClientProvider } from "@tanstack/react-query";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { AuthProvider } from "./contexts/AuthContext.jsx";
import { ThemeProvider } from "./contexts/ThemeContext.jsx";

/**
 * Providers shared by the browser entry and the prerender entry. `children` is the router.
 * `hydrating`: the render must match prerendered HTML (see ThemeProvider).
 */
export default function Root({ queryClient, hydrating = false, devtools = null, children }) {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider hydrating={hydrating}>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
        {devtools}
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
