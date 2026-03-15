import { BrowserRouter, Route, Routes } from "react-router-dom";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";
import AdminPage from "./pages/AdminPage";
import Docs from "./pages/Docs.jsx";
import Home from "./pages/Home.jsx";
import InvoicePayment from "./pages/InvoicePayment.jsx";
import OnboardClient from "./pages/OnboardClient";
import OnboardingSuccess from "./pages/OnboardingSuccess";
import PaymentCancel from "./pages/PaymentCancel";
import PaymentSuccess from "./pages/PaymentSuccess";
import Pricing from "./pages/Pricing.jsx";
import Team from "./pages/Team.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen [background:radial-gradient(circle_at_20%_20%,rgba(44,161,180,0.15),transparent_55%),radial-gradient(circle_at_80%_0%,rgba(11,114,133,0.18),transparent_50%),linear-gradient(180deg,#020617_0%,#020617_55%,#040b18_100%)]">
        <Navbar />
        <main>
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
            <Route path="/pay/:token" element={<InvoicePayment />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
