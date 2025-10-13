import React from 'react'
import Navbar from './components/Navbar.jsx'
import Hero from './components/Hero.jsx'
import ValueProps from './components/ValueProps.jsx'
import Services from './components/Services.jsx'
import CaseStudies from './components/CaseStudies.jsx'
import TechStrip from './components/TechStrip.jsx'
import Contact from './components/Contact.jsx'
import Footer from './components/Footer.jsx'

export default function App() {
  return (
    <div className="min-h-screen gradient-hero">
      <Navbar />
      <main>
        <Hero />
        <ValueProps />
        <Services />
        <CaseStudies />
        <TechStrip />
        <Contact />
      </main>
      <Footer />
    </div>
  )
}
