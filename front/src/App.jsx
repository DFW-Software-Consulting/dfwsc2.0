import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";

const Home = lazy(() => import("./pages/Home.jsx"));
const Pricing = lazy(() => import("./pages/Pricing.jsx"));
const Team = lazy(() => import("./pages/Team.jsx"));
const Docs = lazy(() => import("./pages/Docs.jsx"));
const OnboardClient = lazy(() => import("./pages/OnboardClient"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const PaymentCancel = lazy(() => import("./pages/PaymentCancel"));
const OnboardingSuccess = lazy(() => import("./pages/OnboardingSuccess"));
const RegenerateApiKey = lazy(() => import("./pages/RegenerateApiKey"));
const RequestApiKeyRegeneration = lazy(() => import("./pages/RequestApiKeyRegeneration"));

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen relative isolate bg-[var(--bg-main)] text-[var(--text-main)] selection:bg-brand-500/30 transition-colors duration-300">
        {/* Background glow effects */}
        <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-brand-500/10 blur-[120px] animate-pulse-slow opacity-50 dark:opacity-100" />
          <div className="absolute bottom-[10%] right-[-5%] w-[30%] h-[30%] rounded-full bg-brand-600/10 blur-[100px] animate-pulse-slow opacity-50 dark:opacity-100" />
        </div>

        <Navbar />
        <main className="relative z-10">
          <Suspense
            fallback={
              <div className="flex items-center justify-center min-h-[50vh]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/team" element={<Team />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="/onboard" element={<OnboardClient />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/payment-success" element={<PaymentSuccess />} />
              <Route path="/payment-cancel" element={<PaymentCancel />} />
              <Route path="/onboarding-success" element={<OnboardingSuccess />} />
              <Route path="/regenerate-key" element={<RegenerateApiKey />} />
              <Route path="/request-key-regeneration" element={<RequestApiKeyRegeneration />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
