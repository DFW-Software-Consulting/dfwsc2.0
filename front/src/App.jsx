import { BrowserRouter, Route, Routes } from "react-router-dom";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";
import AdminPage from "./pages/AdminPage";
import Docs from "./pages/Docs.jsx";
import Home from "./pages/Home.jsx";
import OnboardClient from "./pages/OnboardClient";
import OnboardingSuccess from "./pages/OnboardingSuccess";
import PaymentCancel from "./pages/PaymentCancel";
import PaymentSuccess from "./pages/PaymentSuccess";
import Pricing from "./pages/Pricing.jsx";
import Team from "./pages/Team.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen relative isolate bg-[#020617] selection:bg-brand-500/30 selection:text-white">
        {/* Background glow effects */}
        <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-brand-500/10 blur-[120px] animate-pulse-slow" />
          <div className="absolute bottom-[10%] right-[-5%] w-[30%] h-[30%] rounded-full bg-brand-600/10 blur-[100px] animate-pulse-slow" />
        </div>

        <Navbar />
        <main className="relative z-10">
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
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
