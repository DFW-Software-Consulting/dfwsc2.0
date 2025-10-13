import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Hero from '../components/Hero.jsx'
import ValueProps from '../components/ValueProps.jsx'
import Services from '../components/Services.jsx'
import Process from '../components/Process.jsx'
import TechStrip from '../components/TechStrip.jsx'
import CaseStudies from '../components/CaseStudies.jsx'
import Values from '../components/Values.jsx'
import Contact from '../components/Contact.jsx'

export default function Home() {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (location.state?.scrollTo) {
      const id = location.state.scrollTo
      requestAnimationFrame(() => {
        const el = document.getElementById(id)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
      navigate(location.pathname, { replace: true })
    }
  }, [location, navigate])

  return (
    <>
      <Hero />
      <ValueProps />
      <Services />
      <Process />
      <TechStrip />
      <CaseStudies />
      <Values />
      <Contact />
    </>
  )
}
