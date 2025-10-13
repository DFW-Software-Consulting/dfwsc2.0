import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar.jsx'
import Footer from './components/Footer.jsx'
import Home from './pages/Home.jsx'
import Pricing from './pages/Pricing.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen [background:radial-gradient(circle_at_20%_20%,rgba(44,161,180,0.15),transparent_55%),radial-gradient(circle_at_80%_0%,rgba(11,114,133,0.18),transparent_50%),linear-gradient(180deg,#020617_0%,#020617_55%,#040b18_100%)]">
        <Navbar />
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/pricing" element={<Pricing />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  )
}
