import { Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import Analytics from "./components/Analytics.jsx";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";
import RouteTracker from "./components/RouteTracker.jsx";
import { routes } from "./routes.js";
import Seo from "./seo/Seo.jsx";

export default function App() {
  return (
    <>
      <Seo />
      <Analytics />
      <RouteTracker />
      <div className="min-h-screen flex flex-col relative isolate bg-[var(--bg-main)] text-[var(--text-main)] selection:bg-brand-500/30 transition-colors duration-300">
        {/* Background glow effects */}
        <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-brand-500/10 blur-[120px] animate-pulse-slow opacity-50 dark:opacity-100" />
          <div className="absolute bottom-[10%] right-[-5%] w-[30%] h-[30%] rounded-full bg-brand-600/10 blur-[100px] animate-pulse-slow opacity-50 dark:opacity-100" />
        </div>

        <Navbar />
        <main className="relative z-10 flex flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex items-center justify-center min-h-[50vh]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
              </div>
            }
          >
            <Routes>
              {routes.map((route) => (
                <Route key={route.path} path={route.path} element={<route.Page />} />
              ))}
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
    </>
  );
}
