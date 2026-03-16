import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { AuthProvider, authLogoutRef } from "./contexts/AuthContext.jsx";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({
    onError: (err) => {
      if (err?.status === 401 || err?.status === 403) authLogoutRef.current?.();
    },
  }),
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
      {import.meta.env.DEV && <ReactQueryDevtools />}
    </QueryClientProvider>
  </React.StrictMode>
);
