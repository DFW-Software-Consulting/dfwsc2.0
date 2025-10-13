import React from 'react'
import './Banner.css'

const defaultMessage =
  '💼 DFW Software Consulting has a network of THOUSANDS of technology professionals... No tech too obscure 🤖, no project too big 🏗️. We’ve got you covered! 🚀🔥'

const Banner = ({ message = defaultMessage, className = '' }) => {
  const copies = Array.from({ length: 3 })

  return (
    <div className={`banner ${className}`.trim()} role="status" aria-live="polite">
      <div className="banner-track">
        {copies.map((_, index) => (
          <p className="banner-text" key={index} aria-hidden={index !== 0}>
            {message}
          </p>
        ))}
      </div>
    </div>
  )
}

export default Banner
