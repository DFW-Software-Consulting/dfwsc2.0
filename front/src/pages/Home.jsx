import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { scrollToSection } from '../utils/scrollToSection.js'
import Hero from '../components/Hero.jsx'
import ValueProps from '../components/ValueProps.jsx'
import Services from '../components/Services.jsx'
import CaseStudies from '../components/CaseStudies.jsx'
import Banner from '../components/Banner.jsx'
import Values from '../components/Values.jsx'
import Contact from '../components/Contact.jsx'

export default function Home() {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (location.state?.scrollTo) {
      const id = location.state.scrollTo
      requestAnimationFrame(() => {
        scrollToSection(id)
      })
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location, navigate])

  return (
    <>
      <Hero />
      <Banner className="mt-10" />
      <ValueProps />
      <Services />
      <Banner
        className="mt-16"
        message="🔧 Need specialized skills mid-project? Tap into our on-demand engineers to keep your roadmap moving."
      />
      <CaseStudies />
      <Values />
      <Banner
        className="mt-16 mb-16"
        message="📞 Ready for a reliable partner? We help founders, IT teams, and enterprises stabilize, ship, and scale with confidence."
      />
      <Contact />
    </>
  )
}
