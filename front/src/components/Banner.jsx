import React from 'react'
import './Banner.css'

const defaultMessage =
  '💼 DFW Software Consulting has a network of THOUSANDS of technology professionals... No tech too obscure 🤖, no project too big 🏗️. We’ve got you covered! 🚀🔥'

const Banner = ({ message = defaultMessage, className = '' }) => {
  return (
    <div className={`banner ${className}`.trim()} role="status" aria-live="polite">
      <p className="banner-text">{message}</p>
    </div>
  )
}

export default Banner
